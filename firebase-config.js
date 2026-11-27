export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA_0ChjKZtEvYBTlkIKYAIJ-WsKK1vw0AU",
  authDomain: "vacation-packer-app.firebaseapp.com",
  projectId: "vacation-packer-app",
  storageBucket: "vacation-packer-app.firebasestorage.app",
  messagingSenderId: "789386425691",
  appId: "1:789386425691:web:cb4d1194a0925dae07967e"
};

export function isFirebaseConfigured() {
  return Boolean(
    FIREBASE_CONFIG &&
      FIREBASE_CONFIG.apiKey &&
      FIREBASE_CONFIG.projectId &&
      FIREBASE_CONFIG.appId
  );
}
