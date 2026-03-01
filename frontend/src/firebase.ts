import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
    apiKey: "AIzaSyA08i-CNBFJlbmnkgM_KfiVpRQFhK5CWEI",
    authDomain: "perishless-3c73c.firebaseapp.com",
    projectId: "perishless-3c73c",
    storageBucket: "perishless-3c73c.firebasestorage.com",
    messagingSenderId: "295174731377",
    appId: "1:295174731377:web:e165dc14be2edf37b50dd0",
    measurementId: "G-9Z3KZ1Z5Q0",
}

if (!firebaseConfig.projectId) {
    console.warn("Firebase projectId is missing (VITE_FIREBASE_PROJECT_ID). Analytics will be disabled.");
}

const app = initializeApp(firebaseConfig);

const canUseAnalytics =
    typeof window !== "undefined" &&
    !!firebaseConfig.projectId &&
    !!firebaseConfig.measurementId;

if (canUseAnalytics) {
    try {
        getAnalytics(app);
    } catch (err) {
        console.warn("Firebase Analytics init skipped:", err);
    }
}

export const auth = getAuth(app);

