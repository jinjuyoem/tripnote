import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, arrayUnion, serverTimestamp, writeBatch, getDocs,
} from 'firebase/firestore';

const env = import.meta.env;

// 배포 환경에서는 로그인 창을 앱 자체 도메인(/__/auth → vercel.json 프록시)으로 띄워
// 아이폰 사파리/홈화면 앱에서도 로그인이 끊기지 않게 한다.
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const authDomain = isLocal ? env.VITE_FIREBASE_AUTH_DOMAIN : location.host;

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
// 오프라인에서도 마지막으로 본 데이터를 보여주도록 로컬 캐시 사용
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isMobile = () => /iphone|ipad|ipod|android/i.test(navigator.userAgent);

export async function login() {
  if (isStandalone() || isMobile()) return signInWithRedirect(auth, provider);
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    throw e;
  }
}
export const logout = () => signOut(auth);
export const watchAuth = (cb) => { getRedirectResult(auth).catch(() => {}); return onAuthStateChanged(auth, cb); };

export {
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc,
  getDoc, arrayUnion, serverTimestamp, writeBatch, getDocs,
};
