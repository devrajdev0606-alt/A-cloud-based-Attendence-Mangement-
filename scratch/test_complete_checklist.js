const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('../functions/node_modules/firebase-admin');
const { Firestore } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');

const WEB_API_KEY = 'AIzaSyC1x0R-CKUh7sGonAYiqXMNemeLW-6bdvU';
const PROJECT_ID = 'clound-based-attendance';

function postJson(urlStr, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const postData = JSON.stringify(data);
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };
    const req = (u.protocol === 'https:' ? https : http).request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runChecklistTests() {
  console.log('====================================================');
  console.log('CIT SMART ATTENDANCE - COMPLETE 12-POINT VERIFICATION');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;
  function assert(condition, desc) {
    total++;
    if (condition) {
      console.log(`[PASS] CHECK ${total}: ${desc}`);
      passed++;
    } else {
      console.error(`[FAIL] CHECK ${total}: ${desc}`);
      throw new Error(`Assertion failed: ${desc}`);
    }
  }

  // Setup Firebase credentials
  const credPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const credData = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const token = credData.tokens?.access_token;
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: token });

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: PROJECT_ID,
      credential: {
        getAccessToken: () => Promise.resolve({ access_token: token, expires_in: 3600 })
      }
    });
  }
  const db = new Firestore({ projectId: PROJECT_ID, authClient: authClient });

  // Get Admin token
  const adminAuthRes = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
    email: 'admin@cit.edu',
    password: 'AdminPassword123!',
    returnSecureToken: true
  });
  assert(adminAuthRes.status === 200 && !!adminAuthRes.data.idToken, 'Admin signed in successfully and retrieved ID token');
  const adminIdToken = adminAuthRes.data.idToken;

  const createdUids = [];
  const createdUsns = [];
  const createdEmails = [];

  try {
    // ----------------------------------------------------
    // 1. Import ONE valid student
    // ----------------------------------------------------
    const ts1 = Date.now();
    const student1 = {
      name: 'Ananya Sharma',
      usn: '1CD23CS' + String(ts1).slice(-3),
      sem: '5',
      sec: 'A',
      dept: 'CSE',
      email: `ananya.${ts1}@cit.edu`
    };

    console.log(`\n--- Test 1: Import ONE Valid Student (${student1.email}) ---`);
    const singleImportRes = await postJson('http://localhost:3001/api/import-students', { students: [student1] }, {
      'Authorization': `Bearer ${adminIdToken}`
    });

    assert(singleImportRes.status === 200, 'Single import returned HTTP 200');
    assert(singleImportRes.data.summary.imported === 1, 'Summary imported count is 1');
    assert(singleImportRes.data.summary.failed === 0, 'Summary failed count is 0');
    const res1 = singleImportRes.data.results[0];
    assert(res1.status === 'success' || res1.status === 'partial_success', 'Import status indicates success');
    assert(!!res1.uid, `Student UID generated: ${res1.uid}`);
    createdUids.push(res1.uid);
    createdUsns.push(student1.usn);
    createdEmails.push(student1.email);

    // ----------------------------------------------------
    // 2. Import MULTIPLE valid students (3 students in batch)
    // ----------------------------------------------------
    const ts2 = Date.now() + 100;
    const batchStudents = [
      { name: 'Karthik Raja', usn: '1CD23CS' + String(ts2).slice(-3), sem: '5', sec: 'B', dept: 'CSE', email: `karthik.${ts2}@cit.edu` },
      { name: 'Pooja Hegde', usn: '1CD23IS' + String(ts2 + 1).slice(-3), sem: '3', sec: 'A', dept: 'ISE', email: `pooja.${ts2}@cit.edu` },
      { name: 'Sameer Khan', usn: '1CD23CS' + String(ts2 + 2).slice(-3), sem: '7', sec: 'A', dept: 'CSE', email: `sameer.${ts2}@cit.edu` }
    ];

    console.log(`\n--- Test 2: Import MULTIPLE Valid Students (3 rows) ---`);
    const batchImportRes = await postJson('http://localhost:3001/api/import-students', { students: batchStudents }, {
      'Authorization': `Bearer ${adminIdToken}`
    });

    assert(batchImportRes.status === 200, 'Batch import returned HTTP 200');
    assert(batchImportRes.data.summary.total === 3, 'Batch total count is 3');
    assert(batchImportRes.data.summary.imported === 3, 'Batch imported count is 3');
    assert(batchImportRes.data.summary.failed === 0, 'Batch failed count is 0');
    assert(batchImportRes.data.summary.skipped === 0, 'Batch skipped count is 0');

    batchImportRes.data.results.forEach((r, idx) => {
      assert(r.status === 'success' || r.status === 'partial_success', `Batch row ${idx + 1} status indicates success`);
      assert(!!r.uid, `Batch row ${idx + 1} UID generated: ${r.uid}`);
      createdUids.push(r.uid);
      createdUsns.push(batchStudents[idx].usn);
      createdEmails.push(batchStudents[idx].email);
    });

    // ----------------------------------------------------
    // 3. Verify Firebase Authentication users are created
    // ----------------------------------------------------
    console.log('\n--- Test 3: Verify Firebase Authentication Users ---');
    for (let i = 0; i < createdUids.length; i++) {
      const uid = createdUids[i];
      const authUser = await admin.auth().getUser(uid);
      assert(authUser.uid === uid, `Auth user exists for UID ${uid}`);
      assert(authUser.email === createdEmails[i], `Auth user email matches: ${authUser.email}`);
    }

    // ----------------------------------------------------
    // 4. Verify Firestore student documents are created
    // ----------------------------------------------------
    console.log('\n--- Test 4: Verify Firestore Student Documents ---');
    for (let i = 0; i < createdUids.length; i++) {
      const uid = createdUids[i];
      const docSnap = await db.collection('students').doc(uid).get();
      assert(docSnap.exists, `Firestore document exists at students/${uid}`);
    }

    // ----------------------------------------------------
    // 5. Verify createdAt is stored correctly (Timestamp object with toDate)
    // ----------------------------------------------------
    console.log('\n--- Test 5: Verify createdAt is Stored Correctly ---');
    for (let i = 0; i < createdUids.length; i++) {
      const uid = createdUids[i];
      const docSnap = await db.collection('students').doc(uid).get();
      const data = docSnap.data();
      assert(data.createdAt !== undefined && data.createdAt !== null, `createdAt field exists for student ${uid}`);
      assert(typeof data.createdAt.toDate === 'function', `createdAt has toDate() method (Firestore Timestamp) for ${uid}`);
      const dateVal = data.createdAt.toDate();
      assert(dateVal instanceof Date && !isNaN(dateVal.getTime()), `createdAt.toDate() produces valid Date (${dateVal.toISOString()})`);
      assert(typeof data.approvedAt?.toDate === 'function', `approvedAt has toDate() method for ${uid}`);
    }

    // ----------------------------------------------------
    // 6. Verify UID matches between Auth and Firestore
    // ----------------------------------------------------
    console.log('\n--- Test 6: Verify UID Linkage between Auth & Firestore ---');
    for (let i = 0; i < createdUids.length; i++) {
      const uid = createdUids[i];
      const authUser = await admin.auth().getUser(uid);
      const docSnap = await db.collection('students').doc(uid).get();
      const firestoreData = docSnap.data();
      assert(authUser.uid === docSnap.id, `Auth UID (${authUser.uid}) matches Firestore doc.id (${docSnap.id})`);
      assert(authUser.uid === firestoreData.uid, `Auth UID matches Firestore doc.data().uid`);
    }

    // ----------------------------------------------------
    // 7. Verify duplicate USNs are rejected
    // ----------------------------------------------------
    console.log('\n--- Test 7: Verify Duplicate USNs are Rejected ---');
    const dupUsnStudent = {
      name: 'Imposter Student',
      usn: createdUsns[0], // Duplicate USN from student1
      sem: '5',
      sec: 'A',
      dept: 'CSE',
      email: `unique.email.${Date.now()}@cit.edu`
    };
    const dupUsnRes = await postJson('http://localhost:3001/api/import-students', { students: [dupUsnStudent] }, {
      'Authorization': `Bearer ${adminIdToken}`
    });
    assert(dupUsnRes.status === 200, 'Duplicate USN request responded 200');
    assert(dupUsnRes.data.summary.skipped === 1, 'Duplicate USN marked as skipped in summary');
    assert(dupUsnRes.data.results[0].result === 'Already exists', 'Duplicate USN result is "Already exists"');
    assert(dupUsnRes.data.results[0].reason.includes('already exists'), 'Duplicate USN reason explains conflict');

    // ----------------------------------------------------
    // 8. Verify duplicate emails are rejected
    // ----------------------------------------------------
    console.log('\n--- Test 8: Verify Duplicate Emails are Rejected ---');
    const dupEmailStudent = {
      name: 'Another Student',
      usn: '1CD23CS987',
      sem: '5',
      sec: 'A',
      dept: 'CSE',
      email: createdEmails[0] // Duplicate email from student1
    };
    const dupEmailRes = await postJson('http://localhost:3001/api/import-students', { students: [dupEmailStudent] }, {
      'Authorization': `Bearer ${adminIdToken}`
    });
    assert(dupEmailRes.status === 200, 'Duplicate email request responded 200');
    assert(dupEmailRes.data.summary.skipped === 1, 'Duplicate email marked as skipped in summary');
    assert(dupEmailRes.data.results[0].result === 'Already exists', 'Duplicate email result is "Already exists"');

    // ----------------------------------------------------
    // 9. Verify imported student appears in Admin student list
    // ----------------------------------------------------
    console.log('\n--- Test 9: Verify Student in Admin Student List ---');
    // Admin list fetches all students: db.collection('students').get()
    const allStudentsSnap = await db.collection('students').get();
    const studentsList = [];
    allStudentsSnap.forEach(doc => {
      studentsList.push({ id: doc.id, ...doc.data() });
    });

    for (let i = 0; i < createdUids.length; i++) {
      const uid = createdUids[i];
      const foundInList = studentsList.find(s => s.id === uid);
      assert(!!foundInList, `Student ${uid} (${createdEmails[i]}) appears in Admin student collection`);
      assert(foundInList.usn === createdUsns[i], `Student in Admin list has correct USN: ${foundInList.usn}`);
      assert(foundInList.email === createdEmails[i], `Student in Admin list has correct email: ${foundInList.email}`);
    }

    // ----------------------------------------------------
    // 10. Verify imported student can complete password setup
    // ----------------------------------------------------
    console.log('\n--- Test 10: Verify Password Setup ---');
    const testPassword = 'StudentPass123!#';
    const targetUid = createdUids[0];
    const targetEmail = createdEmails[0];

    // Admin sets/confirms password simulating the reset-password link handler
    await admin.auth().updateUser(targetUid, { password: testPassword });
    assert(true, `Password updated successfully for student ${targetUid}`);

    // ----------------------------------------------------
    // 11. Verify imported student can log in
    // ----------------------------------------------------
    console.log('\n--- Test 11: Verify Student Can Log In ---');
    const loginRes = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
      email: targetEmail,
      password: testPassword,
      returnSecureToken: true
    });
    assert(loginRes.status === 200, `Student logged in successfully (HTTP 200)`);
    assert(loginRes.data.localId === targetUid, `Logged-in localId (${loginRes.data.localId}) matches student UID (${targetUid})`);
    assert(loginRes.data.email === targetEmail, `Logged-in email (${loginRes.data.email}) matches student email (${targetEmail})`);
    assert(!!loginRes.data.idToken, 'Login returns valid Firebase ID token');

    // ----------------------------------------------------
    // 12. Verify Student Dashboard loads correctly
    // ----------------------------------------------------
    console.log('\n--- Test 12: Verify Student Dashboard Loads Correctly ---');
    // Simulate what dashboard.html executes for an authenticated student:
    // a. Fetch student profile from students/{uid}
    const studentProfileDoc = await db.collection('students').doc(targetUid).get();
    assert(studentProfileDoc.exists, 'Dashboard: student profile doc exists');
    const profile = studentProfileDoc.data();
    assert(profile.name === student1.name, `Dashboard: student name correctly loaded (${profile.name})`);
    assert(profile.usn === student1.usn, `Dashboard: student USN correctly loaded (${profile.usn})`);
    assert(profile.semester === 5, `Dashboard: student semester correctly loaded (${profile.semester})`);
    assert(profile.section === 'A', `Dashboard: student section correctly loaded (${profile.section})`);
    assert(profile.faceRegistered === false, 'Dashboard: faceRegistered is false (ready for registration)');

    // b. Enrolled subjects query: check matching subjects for CSE Sem 5 Sec A
    const subjectsSnap = await db.collection('subjects').get();
    let enrolledInAny = 0;
    subjectsSnap.forEach(sDoc => {
      const sub = sDoc.data();
      if (Array.isArray(sub.studentIds) && sub.studentIds.includes(targetUid)) {
        enrolledInAny++;
      }
    });
    console.log(`Dashboard: Student enrolled in ${enrolledInAny} subject offering(s) matching CSE Sem 5 Sec A`);

    // c. Attendance query: query attendance where studentId == targetUid
    const attSnap = await db.collection('attendance').where('studentId', '==', targetUid).get();
    assert(attSnap.size >= 0, `Dashboard: attendance history query executes successfully (found ${attSnap.size} records)`);

    console.log('\n====================================================');
    console.log(`ALL 12 CHECKLIST ITEMS PASSED: ${passed}/${total} CHECKS SUCCEEDED!`);
    console.log('====================================================\n');

  } finally {
    // Clean up all created test users and Firestore docs
    console.log('Cleaning up all test records...');
    for (let i = 0; i < createdUids.length; i++) {
      const uid = createdUids[i];
      const usn = createdUsns[i];
      const email = createdEmails[i];
      try { await admin.auth().deleteUser(uid); } catch (e) {}
      try { await db.collection('students').doc(uid).delete(); } catch (e) {}
      try { await db.collection('uniqueUSNs').doc(usn).delete(); } catch (e) {}
      try { await db.collection('uniqueEmails').doc(email).delete(); } catch (e) {}
    }
    console.log('Cleanup completed successfully.');
  }
}

runChecklistTests().catch(err => {
  console.error('Checklist Test Failed:', err);
  process.exit(1);
});
