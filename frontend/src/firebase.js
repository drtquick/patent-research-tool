import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyC9ESa468JTpPJwhtBvKpeUT8bPFXQMilo",
  authDomain: "patent-research-tool.firebaseapp.com",
  projectId: "patent-research-tool",
  storageBucket: "patent-research-tool.firebasestorage.app",
  messagingSenderId: "342777145569",
  appId: "1:342777145569:web:82c0aed9ac335ad3226fa0",
};

const app = initializeApp(firebaseConfig);
export const auth          = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const storage        = getStorage(app);
