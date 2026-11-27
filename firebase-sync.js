import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  arrayUnion,
  arrayRemove,
  deleteField,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { FIREBASE_CONFIG, isFirebaseConfigured } from "./firebase-config.js";

const PENDING_JOIN_KEY = "packlist_pending_join_code";
const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let app = null;
let auth = null;
let db = null;
let googleProvider = null;

let isInitialized = false;
let currentUser = null;
let syncStatus = "local"; // 'local' | 'syncing' | 'synced' | 'offline' | 'error'

let unsubMemberTrips = null;
let unsubInvitedTrips = null;
let memberTripsById = new Map();
let invitedTripsById = new Map();
let currentTripsMap = new Map();
let hasReceivedInitialSnapshot = false;
let hasReceivedServerSnapshot = false;

const enrollingTripIds = new Set();
const saveTimers = new Map();
const pendingSaveTrips = new Map();

function notifyApp(method, ...args) {
  try {
    const bridge = window.PackListApp;
    if (bridge && typeof bridge[method] === "function") {
      bridge[method](...args);
    }
  } catch (err) {
    console.error(`PackListApp.${method} error:`, err);
  }
}

function setSyncStatus(nextStatus) {
  syncStatus = nextStatus;
  notifyApp("onSyncStatusChange", nextStatus);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeJoinCode(rawCode) {
  return String(rawCode || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function generateJoinCode(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
  }
  return code;
}

function buildMemberRecord(user, role = "editor") {
  return {
    email: normalizeEmail(user.email),
    displayName: user.displayName || user.email || (role === "owner" ? "Owner" : "Collaborator"),
    photoURL: user.photoURL || "",
    role,
    joinedAt: new Date().toISOString()
  };
}

function mapDocToTrip(docSnap) {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    title: data.title || "Untitled Trip",
    createdAt: data.createdAt || new Date().toISOString(),
    categories: Array.isArray(data.categories) ? data.categories : [],
    ownerUid: data.ownerUid || null,
    ownerEmail: data.ownerEmail || "",
    ownerName: data.ownerName || "",
    memberUids: Array.isArray(data.memberUids) ? data.memberUids : [],
    members: data.members && typeof data.members === "object" ? data.members : {},
    invitedEmails: Array.isArray(data.invitedEmails) ? data.invitedEmails : [],
    joinCode: data.joinCode || null,
    joinCodeEnabled: Boolean(data.joinCodeEnabled),
    updatedBy: data.updatedBy || null
  };
}

function cleanupSubscriptions() {
  if (unsubMemberTrips) {
    unsubMemberTrips();
    unsubMemberTrips = null;
  }
  if (unsubInvitedTrips) {
    unsubInvitedTrips();
    unsubInvitedTrips = null;
  }
  memberTripsById.clear();
  invitedTripsById.clear();
  currentTripsMap.clear();
  enrollingTripIds.clear();
  hasReceivedInitialSnapshot = false;
  hasReceivedServerSnapshot = false;
  for (const timer of saveTimers.values()) {
    clearTimeout(timer);
  }
  saveTimers.clear();
  pendingSaveTrips.clear();
}

function emitMergedTrips(fromCache = false) {
  const merged = new Map();
  for (const [id, trip] of invitedTripsById.entries()) {
    merged.set(id, trip);
  }
  for (const [id, trip] of memberTripsById.entries()) {
    merged.set(id, trip);
  }
  currentTripsMap = merged;

  const sortedTrips = Array.from(merged.values()).sort((a, b) => {
    const aTime = Date.parse(a.createdAt || 0) || 0;
    const bTime = Date.parse(b.createdAt || 0) || 0;
    return aTime - bTime;
  });

  const initialLoad = !hasReceivedInitialSnapshot;
  hasReceivedInitialSnapshot = true;

  if (!navigator.onLine) {
    setSyncStatus("offline");
  } else {
    setSyncStatus(fromCache ? "syncing" : "synced");
  }

  notifyApp("onCloudTripsUpdate", sortedTrips, {
    initialLoad,
    fromCache,
    serverSynced: hasReceivedServerSnapshot
  });
}

async function autoEnrollInvitedTrip(trip) {
  if (!currentUser || !db) return;
  if (trip.memberUids.includes(currentUser.uid)) return;
  if (enrollingTripIds.has(trip.id)) return;

  enrollingTripIds.add(trip.id);
  try {
    await updateDoc(doc(db, "trips", trip.id), {
      memberUids: arrayUnion(currentUser.uid),
      [`members.${currentUser.uid}`]: buildMemberRecord(currentUser, "editor"),
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("Auto-enroll for invited trip failed:", err);
  } finally {
    enrollingTripIds.delete(trip.id);
  }
}

function startSubscriptions(user) {
  cleanupSubscriptions();
  if (!db || !user) return;

  setSyncStatus(navigator.onLine ? "syncing" : "offline");

  const memberQuery = query(
    collection(db, "trips"),
    where("memberUids", "array-contains", user.uid)
  );

  unsubMemberTrips = onSnapshot(
    memberQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      const next = new Map();
      snapshot.forEach((docSnap) => {
        next.set(docSnap.id, mapDocToTrip(docSnap));
      });
      memberTripsById = next;
      if (!snapshot.metadata.fromCache) {
        hasReceivedServerSnapshot = true;
      }
      emitMergedTrips(snapshot.metadata.fromCache);
    },
    (err) => {
      console.error("Firestore member trips listener error:", err);
      setSyncStatus("error");
      const detail = err?.code ? ` (${err.code})` : "";
      notifyApp("notifyToast", `Unable to sync trips from cloud${detail}`, true);
    }
  );

  if (user.email && user.emailVerified) {
    const emailLower = normalizeEmail(user.email);
    const invitedQuery = query(
      collection(db, "trips"),
      where("invitedEmails", "array-contains", emailLower)
    );

    unsubInvitedTrips = onSnapshot(
      invitedQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        const next = new Map();
        snapshot.forEach((docSnap) => {
          const trip = mapDocToTrip(docSnap);
          next.set(docSnap.id, trip);
          if (!trip.memberUids.includes(user.uid)) {
            autoEnrollInvitedTrip(trip);
          }
        });
        invitedTripsById = next;
        emitMergedTrips(snapshot.metadata.fromCache);
      },
      (err) => {
        console.warn("Firestore invited trips listener error:", err);
      }
    );
  }
}

function mapAuthError(err) {
  const code = err?.code || "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return "Sign-in was canceled.";
  }
  if (code === "auth/popup-blocked") {
    return "Pop-up was blocked by your browser. Please allow pop-ups for this site and try again.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Google Sign-In is not enabled yet in Firebase Console (Authentication → Sign-in method).";
  }
  if (code === "auth/unauthorized-domain") {
    return `Domain "${window.location.hostname}" is not authorized yet in Firebase Auth settings.`;
  }
  if (code === "auth/network-request-failed") {
    return "Network error during sign-in. Check your connection and try again.";
  }
  return err?.message || "Google Sign-In failed.";
}

async function safeDeleteJoinCode(code) {
  if (!code || !db) return;
  const codeRef = doc(db, "joinCodes", code);
  try {
    const snap = await getDoc(codeRef);
    if (snap.exists()) {
      await deleteDoc(codeRef);
    }
  } catch (err) {
    console.warn("Skipping joinCode cleanup:", err?.code || err);
  }
}

function buildNewTripPayload(tripObj, user) {
  return {
    ownerUid: user.uid,
    ownerEmail: normalizeEmail(user.email),
    ownerName: user.displayName || user.email || "Trip Owner",
    memberUids: [user.uid],
    members: {
      [user.uid]: buildMemberRecord(user, "owner")
    },
    invitedEmails: [],
    joinCode: null,
    joinCodeEnabled: false,
    title: tripObj.title || "Ultimate Vacation Pack",
    createdAt: tripObj.createdAt || new Date().toISOString(),
    categories: Array.isArray(tripObj.categories) ? tripObj.categories : [],
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  };
}

function initFirebase() {
  if (!isFirebaseConfigured()) {
    console.warn("Firebase config missing; staying in local-only mode.");
    return;
  }

  try {
    app = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: "select_account" });

    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager()
        })
      });
    } catch (cacheErr) {
      console.warn("Persistent Firestore cache unavailable, falling back to default:", cacheErr);
      db = getFirestore(app);
    }

    isInitialized = true;

    window.addEventListener("online", () => {
      if (currentUser) setSyncStatus("syncing");
    });
    window.addEventListener("offline", () => {
      if (currentUser) setSyncStatus("offline");
    });

    onAuthStateChanged(auth, (user) => {
      currentUser = user || null;
      if (currentUser) {
        startSubscriptions(currentUser);
      } else {
        cleanupSubscriptions();
        setSyncStatus("local");
      }
      notifyApp("onAuthChange", currentUser);
    });
  } catch (err) {
    console.warn("Firebase initialization failed; continuing in local-only mode:", err);
    isInitialized = false;
    setSyncStatus("local");
  }
}

const PackListCloud = {
  isReady() {
    return isInitialized;
  },
  isSignedIn() {
    return Boolean(currentUser);
  },
  getUser() {
    return currentUser;
  },
  getSyncStatus() {
    return syncStatus;
  },
  getProjectId() {
    return FIREBASE_CONFIG.projectId;
  },

  async signInWithGoogle() {
    if (!isInitialized || !auth || !googleProvider) {
      throw new Error("Cloud sync is unavailable right now (offline or unconfigured).");
    }
    try {
      const result = await signInWithPopup(auth, googleProvider);
      return result.user;
    } catch (err) {
      throw new Error(mapAuthError(err));
    }
  },

  async signOutUser() {
    if (!auth) return;
    await this.flushPendingSaves();
    cleanupSubscriptions();
    await signOut(auth);
  },

  async createTrip(tripObj) {
    if (!currentUser || !db) throw new Error("Sign in required.");
    setSyncStatus(navigator.onLine ? "syncing" : "offline");
    const payload = buildNewTripPayload(tripObj, currentUser);
    await setDoc(doc(db, "trips", tripObj.id), payload);
    if (navigator.onLine) setSyncStatus("synced");
  },

  saveTripContent(tripObj, { immediate = false } = {}) {
    if (!currentUser || !db || !tripObj?.id) return Promise.resolve();

    const snapshotTrip = {
      id: tripObj.id,
      title: tripObj.title || "Untitled Trip",
      categories: JSON.parse(JSON.stringify(tripObj.categories || []))
    };
    pendingSaveTrips.set(snapshotTrip.id, snapshotTrip);

    if (saveTimers.has(snapshotTrip.id)) {
      clearTimeout(saveTimers.get(snapshotTrip.id));
      saveTimers.delete(snapshotTrip.id);
    }

    const commit = async () => {
      saveTimers.delete(snapshotTrip.id);
      const toWrite = pendingSaveTrips.get(snapshotTrip.id);
      if (!toWrite || !currentUser || !db) return;
      pendingSaveTrips.delete(snapshotTrip.id);

      setSyncStatus(navigator.onLine ? "syncing" : "offline");
      try {
        await updateDoc(doc(db, "trips", toWrite.id), {
          title: toWrite.title,
          categories: toWrite.categories,
          updatedAt: serverTimestamp(),
          updatedBy: currentUser.uid
        });
        if (navigator.onLine) setSyncStatus("synced");
      } catch (err) {
        console.error("Failed to save trip content to Firestore:", err);
        setSyncStatus("error");
        notifyApp("notifyToast", "Failed to save changes to cloud", true);
      }
    };

    if (immediate) {
      return commit();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        await commit();
        resolve();
      }, 200);
      saveTimers.set(snapshotTrip.id, timer);
    });
  },

  async flushPendingSaves() {
    const ids = Array.from(pendingSaveTrips.keys());
    await Promise.all(
      ids.map((id) => {
        const trip = pendingSaveTrips.get(id);
        return trip ? this.saveTripContent(trip, { immediate: true }) : Promise.resolve();
      })
    );
  },

  async deleteTrip(tripObj) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid && tripObj.ownerUid !== currentUser.uid) {
      throw new Error("Only the trip owner can delete this trip.");
    }
    if (saveTimers.has(tripObj.id)) {
      clearTimeout(saveTimers.get(tripObj.id));
      saveTimers.delete(tripObj.id);
    }
    pendingSaveTrips.delete(tripObj.id);

    if (tripObj.joinCode) {
      await safeDeleteJoinCode(tripObj.joinCode);
    }
    await deleteDoc(doc(db, "trips", tripObj.id));
  },

  async leaveTrip(tripObj) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid === currentUser.uid) {
      throw new Error("Owners cannot leave their own trip—delete it instead.");
    }
    const updates = {
      memberUids: arrayRemove(currentUser.uid),
      [`members.${currentUser.uid}`]: deleteField(),
      updatedAt: serverTimestamp()
    };
    if (currentUser.email) {
      updates.invitedEmails = arrayRemove(normalizeEmail(currentUser.email));
    }
    await updateDoc(doc(db, "trips", tripObj.id), updates);
  },

  async enableOrRotateJoinCode(tripObj) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid !== currentUser.uid) {
      throw new Error("Only the trip owner can manage the join code.");
    }

    const oldCode = tripObj.joinCode;
    const newCode = generateJoinCode(8);

    await updateDoc(doc(db, "trips", tripObj.id), {
      joinCode: newCode,
      joinCodeEnabled: true,
      updatedAt: serverTimestamp()
    });

    await setDoc(doc(db, "joinCodes", newCode), {
      tripId: tripObj.id,
      tripTitle: tripObj.title || "Shared Trip",
      ownerUid: currentUser.uid,
      createdAt: serverTimestamp()
    });

    if (oldCode && oldCode !== newCode) {
      await safeDeleteJoinCode(oldCode);
    }
    return newCode;
  },

  async setJoinCodeEnabled(tripObj, enabled) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid !== currentUser.uid) {
      throw new Error("Only the trip owner can update join code settings.");
    }

    if (enabled && !tripObj.joinCode) {
      return await this.enableOrRotateJoinCode(tripObj);
    }

    const code = tripObj.joinCode;
    if (enabled && code) {
      await updateDoc(doc(db, "trips", tripObj.id), {
        joinCodeEnabled: true,
        updatedAt: serverTimestamp()
      });
      await setDoc(doc(db, "joinCodes", code), {
        tripId: tripObj.id,
        tripTitle: tripObj.title || "Shared Trip",
        ownerUid: currentUser.uid,
        createdAt: serverTimestamp()
      });
      return code;
    }

    await updateDoc(doc(db, "trips", tripObj.id), {
      joinCodeEnabled: false,
      updatedAt: serverTimestamp()
    });
    if (code) {
      await safeDeleteJoinCode(code);
    }
    return null;
  },

  async addInvitedEmail(tripObj, rawEmail) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid !== currentUser.uid) {
      throw new Error("Only the trip owner can invite collaborators.");
    }
    const email = normalizeEmail(rawEmail);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.");
    }
    if (email === normalizeEmail(tripObj.ownerEmail || currentUser.email)) {
      throw new Error("You are already the owner of this trip.");
    }
    if (Array.isArray(tripObj.invitedEmails) && tripObj.invitedEmails.includes(email)) {
      throw new Error(`${email} is already invited.`);
    }

    await updateDoc(doc(db, "trips", tripObj.id), {
      invitedEmails: arrayUnion(email),
      updatedAt: serverTimestamp()
    });
    return email;
  },

  async removeInvitedEmail(tripObj, rawEmail) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid !== currentUser.uid) {
      throw new Error("Only the trip owner can remove invited emails.");
    }
    const email = normalizeEmail(rawEmail);
    await updateDoc(doc(db, "trips", tripObj.id), {
      invitedEmails: arrayRemove(email),
      updatedAt: serverTimestamp()
    });
  },

  async removeMember(tripObj, targetUid) {
    if (!currentUser || !db || !tripObj?.id) throw new Error("Sign in required.");
    if (tripObj.ownerUid !== currentUser.uid) {
      throw new Error("Only the trip owner can remove members.");
    }
    if (targetUid === tripObj.ownerUid) {
      throw new Error("Cannot remove the trip owner.");
    }

    const memberEmail = normalizeEmail(tripObj.members?.[targetUid]?.email);
    const updates = {
      memberUids: arrayRemove(targetUid),
      [`members.${targetUid}`]: deleteField(),
      updatedAt: serverTimestamp()
    };
    if (memberEmail) {
      updates.invitedEmails = arrayRemove(memberEmail);
    }
    await updateDoc(doc(db, "trips", tripObj.id), updates);
  },

  async redeemJoinCode(rawCode) {
    if (!currentUser || !db) throw new Error("Please sign in with Google to join a trip.");
    const code = normalizeJoinCode(rawCode);
    if (code.length < 6 || code.length > 16) {
      throw new Error("Join code must be 6–16 letters or numbers.");
    }

    const codeSnap = await getDoc(doc(db, "joinCodes", code));
    if (!codeSnap.exists()) {
      throw new Error("Invalid or disabled join code. Double-check with the trip owner.");
    }

    const { tripId, tripTitle } = codeSnap.data();
    const existing = currentTripsMap.get(tripId);
    if (existing && Array.isArray(existing.memberUids) && existing.memberUids.includes(currentUser.uid)) {
      return { tripId, tripTitle: existing.title || tripTitle || "Shared Trip", alreadyMember: true };
    }

    try {
      await updateDoc(doc(db, "trips", tripId), {
        memberUids: arrayUnion(currentUser.uid),
        [`members.${currentUser.uid}`]: buildMemberRecord(currentUser, "editor"),
        lastJoinedCode: code,
        updatedAt: serverTimestamp()
      });
      return { tripId, tripTitle: tripTitle || "Shared Trip", alreadyMember: false };
    } catch (err) {
      if (err?.code === "permission-denied") {
        try {
          const tripSnap = await getDoc(doc(db, "trips", tripId));
          if (tripSnap.exists()) {
            return { tripId, tripTitle: tripSnap.data().title || tripTitle || "Shared Trip", alreadyMember: true };
          }
        } catch (_) {}
        throw new Error("This join code is no longer active or has been rotated.");
      }
      throw err;
    }
  },

  needsMigrationCheck(localTrips) {
    if (!currentUser) return false;
    try {
      const marker = localStorage.getItem(`packlist_migrated_${currentUser.uid}`);
      return !marker && Array.isArray(localTrips) && localTrips.length > 0;
    } catch (_) {
      return false;
    }
  },

  async uploadLocalTrips(localTrips) {
    if (!currentUser || !db) throw new Error("Sign in required.");
    const list = Array.isArray(localTrips) ? localTrips : [];
    const createdIds = [];
    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      const baseId = String(src.id || `trip_${Date.now()}_${i}`);
      const safeId = currentTripsMap.has(baseId)
        ? `trip_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`
        : baseId;
      const tripToUpload = {
        ...src,
        id: safeId
      };
      await this.createTrip(tripToUpload);
      createdIds.push(safeId);
    }
    try {
      localStorage.setItem(`packlist_migrated_${currentUser.uid}`, new Date().toISOString());
    } catch (_) {}
    return createdIds;
  },

  markMigrationSkipped() {
    if (!currentUser) return;
    try {
      localStorage.setItem(`packlist_migrated_${currentUser.uid}`, "skipped");
    } catch (_) {}
  },

  setPendingJoinCode(rawCode) {
    const code = normalizeJoinCode(rawCode);
    if (!code) return;
    try {
      sessionStorage.setItem(PENDING_JOIN_KEY, code);
    } catch (_) {}
  },

  getPendingJoinCode() {
    try {
      return sessionStorage.getItem(PENDING_JOIN_KEY) || "";
    } catch (_) {
      return "";
    }
  },

  clearPendingJoinCode() {
    try {
      sessionStorage.removeItem(PENDING_JOIN_KEY);
    } catch (_) {}
  },

  formatJoinCode(code) {
    const clean = normalizeJoinCode(code);
    if (clean.length === 8) {
      return `${clean.slice(0, 4)}-${clean.slice(4)}`;
    }
    return clean;
  }
};

window.PackListCloud = PackListCloud;
initFirebase();
