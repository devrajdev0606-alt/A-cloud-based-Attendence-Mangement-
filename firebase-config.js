const firebaseConfig = {
  apiKey: "AIzaSyC1x0R-CKUh7sGonAYiqXMNemeLW-6bdvU",
  authDomain: "clound-based-attendance.firebaseapp.com",
  projectId: "clound-based-attendance",
  storageBucket: "clound-based-attendance.firebasestorage.app",
  messagingSenderId: "1009419832315",
  appId: "1:1009419832315:web:729de727f749e64164195e",
  measurementId: "G-HZHQNMZQG4"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

window.db = firebase.firestore();
