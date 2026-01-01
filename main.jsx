import "./style.css";
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged
} from "firebase/auth";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  serverTimestamp,
  query,
  orderBy,
  onSnapshot,
  where,
  increment
} from "firebase/firestore";
import { getMessaging, getToken } from "firebase/messaging";

/* ======================
   Kinship – Firebase
   ====================== */

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const messaging = getMessaging(app);

/* ======================
   Kinship – Constants
   ====================== */

const POST_WINDOW_MS = 60_000;
const COMMENT_WINDOW_MS = 15_000;

const TRUST_LIKE_GAIN = 1;
const TRUST_REPORT_PENALTY = 2;
const TRUST_MUTE_THRESHOLD = -5;

/* ======================
   Helpers
   ====================== */

async function rateLimit(db, uid, type, windowMs) {
  const ref = doc(db, "rate_limits", `${uid}_${type}`);
  const snap = await getDoc(ref);
  const now = Date.now();

  if (snap.exists()) {
    const last = snap.data().at?.toMillis?.() || 0;
    if (now - last < windowMs) return false;
  }

  await setDoc(ref, { at: serverTimestamp() }, { merge: true });
  return true;
}

/* ======================
   Kinship App
   ====================== */

function KinshipApp() {
  const isMobile = window.innerWidth < 768;

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);

  const [posts, setPosts] = useState([]);
  const [comments, setComments] = useState([]);
  const [friends, setFriends] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [reports, setReports] = useState([]);

  const [postText, setPostText] = useState("");
  const [commentText, setCommentText] = useState({});
  const [replyText, setReplyText] = useState({});

  const [dark, setDark] = useState(false);
  const [viewProfileUid, setViewProfileUid] = useState(null);

  /* ======================
     Auth & Identity
     ====================== */

  useEffect(() => {
    document.title = "Kinship";

    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (!u) return;

      const ref = doc(db, "users", u.uid);
      const snap = await getDoc(ref);

      if (!snap.exists()) {
        await setDoc(ref, {
          username: u.displayName || "member",
          bio: "",
          role: "user",
          trust: 0,
          muted: false,
          darkMode: false,
          createdAt: serverTimestamp()
        });
      }

      const fresh = await getDoc(ref);
      setProfile(fresh.data());
      setDark(!!fresh.data().darkMode);
    });
  }, []);

  /* ======================
     Subscriptions
     ====================== */

  useEffect(() => {
    const q = query(collection(db, "posts"), orderBy("createdAt", "desc"));
    return onSnapshot(q, s =>
      setPosts(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, []);

  useEffect(() => {
    const q = query(collection(db, "comments"), orderBy("createdAt"));
    return onSnapshot(q, s =>
      setComments(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "friends"),
      where("users", "array-contains", user.uid)
    );
    return onSnapshot(q, s =>
      setFriends(s.docs.map(d => d.data().users.find(u => u !== user.uid)))
    );
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "friend_requests"),
      where("to", "==", user.uid),
      where("status", "==", "pending")
    );
    return onSnapshot(q, s =>
      setFriendRequests(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [user]);

  useEffect(() => {
    if (!user || profile?.role === "user") return;
    const q = query(collection(db, "reports"), orderBy("createdAt", "desc"));
    return onSnapshot(q, s =>
      setReports(s.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [user, profile]);

  /* ======================
     Push Notifications
     ====================== */

  const enableNotifications = async () => {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;

    const token = await getToken(messaging, {
      vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY
    });

    if (token && user) {
      await setDoc(doc(db, "push_tokens", `${user.uid}_${token}`), {
        uid: user.uid,
        token,
        createdAt: serverTimestamp()
      });
      alert("Kinship notifications enabled.");
    }
  };

  /* ======================
     Actions
     ====================== */

  const login = () =>
    signInWithPopup(auth, new GoogleAuthProvider());

  const toggleDark = async () => {
    await updateDoc(doc(db, "users", user.uid), { darkMode: !dark });
    setDark(!dark);
  };

  const createPost = async () => {
    if (!postText.trim()) return;
    if (profile?.muted) return alert("You are muted in Kinship.");

    const ok = await rateLimit(db, user.uid, "post", POST_WINDOW_MS);
    if (!ok) return alert("Slow down. Kinship values quality.");

    await addDoc(collection(db, "posts"), {
      text: postText,
      uid: user.uid,
      likes: 0,
      visibility: "public",
      createdAt: serverTimestamp()
    });

    setPostText("");
  };

  const likePost = async (post) => {
    if (profile?.muted) return;

    const ref = doc(db, "likes", `${post.id}_${user.uid}`);
    const snap = await getDoc(ref);
    if (snap.exists()) return;

    await setDoc(ref, {
      postId: post.id,
      uid: user.uid,
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, "posts", post.id), {
      likes: increment(1)
    });

    await updateDoc(doc(db, "users", post.uid), {
      trust: increment(TRUST_LIKE_GAIN)
    });
  };

  const addComment = async (postId, parentId = null) => {
    const text = parentId ? replyText[parentId] : commentText[postId];
    if (!text) return;
    if (profile?.muted) return;

    const ok = await rateLimit(db, user.uid, "comment", COMMENT_WINDOW_MS);
    if (!ok) return alert("Please wait before commenting again.");

    await addDoc(collection(db, "comments"), {
      postId,
      parentId,
      uid: user.uid,
      text,
      createdAt: serverTimestamp()
    });

    setCommentText({ ...commentText, [postId]: "" });
    setReplyText({ ...replyText, [parentId]: "" });
  };

  const sendFriendRequest = async (to) => {
    await setDoc(doc(db, "friend_requests", `${user.uid}_${to}`), {
      from: user.uid,
      to,
      status: "pending",
      createdAt: serverTimestamp()
    });
  };

  const approveFriend = async (r) => {
    await updateDoc(doc(db, "friend_requests", r.id), {
      status: "accepted"
    });

    await setDoc(doc(db, "friends", `${r.from}_${r.to}`), {
      users: [r.from, r.to],
      since: serverTimestamp()
    });
  };

  const report = async (type, targetId, targetUid, reason) => {
    await addDoc(collection(db, "reports"), {
      type,
      targetId,
      targetUid,
      from: user.uid,
      reason,
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, "users", targetUid), {
      trust: increment(-TRUST_REPORT_PENALTY)
    });
  };

  /* ======================
     Feeds
     ====================== */

  const friendFeed = useMemo(
    () => posts.filter(p => friends.includes(p.uid)),
    [posts, friends]
  );

  const publicFeed = useMemo(
    () => posts.filter(p => p.visibility === "public"),
    [posts]
  );

  const trending = useMemo(
    () => [...posts].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 5),
    [posts]
  );

  /* ======================
     UI
     ====================== */

  return (
    <div className={`app ${dark ? "dark" : ""}`}>
      {!user && (
        <>
          <h1 className="center">Kinship</h1>
          <p className="center">A community built on trust and friendship.</p>
          <button onClick={login}>Join Kinship</button>
        </>
      )}

      {user && profile && (
        <>
          {/* Dashboard */}
          <section className="dashboard">
            <h2>Kinship Dashboard</h2>
            <p><b>{profile.username}</b></p>
            <p>Role: {profile.role}</p>
            <p>Trust: {profile.trust}</p>
            <button onClick={toggleDark}>
              {dark ? "Light" : "Dark"} Mode
            </button>
            <button onClick={enableNotifications}>
              Enable Notifications
            </button>
          </section>

          {/* Friend Requests */}
          {friendRequests.length > 0 && (
            <section className="dashboard">
              <h3>Friend Requests</h3>
              {friendRequests.map(r => (
                <div key={r.id}>
                  <span>{r.from}</span>
                  <button onClick={() => approveFriend(r)}>
                    Accept
                  </button>
                </div>
              ))}
            </section>
          )}

          {/* Composer */}
          <section className="post-composer">
            <textarea
              placeholder="Share something with Kinship..."
              value={postText}
              onChange={e => setPostText(e.target.value)}
            />
            <button onClick={createPost}>Post</button>
          </section>

          {/* Trending */}
          <section className="dashboard">
            <h3>Trending on Kinship</h3>
            {trending.map(p => (
              <div key={p.id}>🔥 {p.text.slice(0, 40)}</div>
            ))}
          </section>

          {/* Friends Feed */}
          <section className="dashboard">
            <h3>Friends Feed</h3>
            {friendFeed.map(p => (
              <div key={p.id} className="post">
                <p onClick={() => setViewProfileUid(p.uid)}>
                  {p.text}
                </p>
                <button onClick={() => likePost(p)}>Like</button>
                <button
                  onClick={() =>
                    report("post", p.id, p.uid, "Inappropriate")
                  }
                >
                  Report
                </button>
              </div>
            ))}
          </section>

          {/* Public Feed */}
          <section className="dashboard">
            <h3>Public Feed</h3>
            {publicFeed.map(p => (
              <div key={p.id} className="post">
                <p onClick={() => setViewProfileUid(p.uid)}>
                  {p.text}
                </p>
                <small>Likes: {p.likes || 0}</small>
                <button onClick={() => likePost(p)}>Like</button>
                <button onClick={() => sendFriendRequest(p.uid)}>
                  Add Friend
                </button>

                {comments
                  .filter(c => c.postId === p.id && !c.parentId)
                  .map(c => (
                    <div key={c.id} style={{ marginLeft: 10 }}>
                      <p>{c.text}</p>
                      <button
                        onClick={() =>
                          report("comment", c.id, c.uid, "Abuse")
                        }
                      >
                        Flag
                      </button>

                      {comments
                        .filter(r => r.parentId === c.id)
                        .map(r => (
                          <p key={r.id} style={{ marginLeft: 20 }}>
                            ↳ {r.text}
                          </p>
                        ))}

                      <input
                        placeholder="Reply..."
                        value={replyText[c.id] || ""}
                        onChange={e =>
                          setReplyText({
                            ...replyText,
                            [c.id]: e.target.value
                          })
                        }
                      />
                      <button onClick={() => addComment(p.id, c.id)}>
                        Reply
                      </button>
                    </div>
                  ))}

                <input
                  placeholder="Comment..."
                  value={commentText[p.id] || ""}
                  onChange={e =>
                    setCommentText({
                      ...commentText,
                      [p.id]: e.target.value
                    })
                  }
                />
                <button onClick={() => addComment(p.id)}>
                  Comment
                </button>
              </div>
            ))}
          </section>

          {/* Profile Page */}
          {viewProfileUid && (
            <section className="dashboard">
              <button onClick={() => setViewProfileUid(null)}>
                Close Profile
              </button>
              <h3>Kinship Profile</h3>
              {posts
                .filter(p => p.uid === viewProfileUid)
                .map(p => (
                  <p key={p.id}>{p.text}</p>
                ))}
            </section>
          )}

          {/* Admin Reports */}
          {!isMobile && profile.role !== "user" && (
            <section className="dashboard">
              <h3>Kinship Moderation</h3>
              {reports.map(r => (
                <div key={r.id}>
                  <p>{r.type}: {r.reason}</p>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ======================
   Render
   ====================== */

ReactDOM.createRoot(document.getElementById("root")).render(
  <KinshipApp />
);
