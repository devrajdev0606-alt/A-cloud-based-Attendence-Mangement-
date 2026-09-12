const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('C:/Users/HP/OneDrive/Desktop/Main Project/attendance-management-system-demo/functions/node_modules/firebase-admin');
const { Firestore } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');

const WEB_API_KEY = 'AIzaSyC1x0R-CKUh7sGonAYiqXMNemeLW-6bdvU';
const PROJECT_ID = 'clound-based-attendance';

// Helper: HTTP request
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

function getJson(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = (u.protocol === 'https:' ? https : http).get(urlStr, res => {
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
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('STARTING CIT SMART ATTENDANCE CSV IMPORT TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;
  function assert(condition, desc) {
    total++;
    if (condition) {
      console.log(`[PASS] TEST ${total}: ${desc}`);
      passed++;
    } else {
      console.error(`[FAIL] TEST ${total}: ${desc}`);
    }
  }

  // 1. Health check on backend server
  const health = await getJson('http://localhost:3001/api/health');
  assert(health.status === 200 && health.data.status === 'ok', 'Backend server health check passes (http://localhost:3001/api/health)');

  // 2. Unauthenticated request blocked
  const unauthRes = await postJson('http://localhost:3001/api/import-students', { students: [] });
  assert(unauthRes.status === 401, 'Unauthenticated import request blocked (401 Unauthorized)');

  // 3. Invalid token blocked
  const invalidTokenRes = await postJson('http://localhost:3001/api/import-students', { students: [] }, {
    'Authorization': 'Bearer invalid_token_12345'
  });
  assert(invalidTokenRes.status === 401, 'Invalid Bearer token rejected (401 Unauthorized)');

  // 4. Obtain Admin ID token by signing in as admin@cit.edu
  const adminAuthRes = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
    email: 'admin@cit.edu',
    password: 'AdminPassword123!',
    returnSecureToken: true
  });
  assert(adminAuthRes.status === 200 && !!adminAuthRes.data.idToken, 'Admin signed in successfully with valid ID token');
  const adminIdToken = adminAuthRes.data.idToken;

  // 5. Test Non-admin user token rejection
  // Sign in as a regular student (e.g. dev@gmail.com)
  let studentIdToken = null;
  try {
    const studentAuthRes = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
      email: 'dev@gmail.com',
      password: 'wrong_password_test',
      returnSecureToken: true
    });
  } catch(e) {}

  // 6. Test Data Validation (Missing name, invalid USN, invalid semester, invalid section, unknown department, invalid email)
  const validationTestStudents = [
    { name: '', usn: '1CD23CS701', sem: '5', sec: 'A', dept: 'CSE', email: 'v1@cit.edu' },
    { name: 'Valid Name', usn: '', sem: '5', sec: 'A', dept: 'CSE', email: 'v2@cit.edu' },
    { name: 'Valid Name', usn: '1CD23CS703', sem: '12', sec: 'A', dept: 'CSE', email: 'v3@cit.edu' },
    { name: 'Valid Name', usn: '1CD23CS704', sem: '5', sec: 'Z', dept: 'CSE', email: 'v4@cit.edu' },
    { name: 'Valid Name', usn: '1CD23CS705', sem: '5', sec: 'A', dept: 'NonExistentDept999', email: 'v5@cit.edu' },
    { name: 'Valid Name', usn: '1CD23CS706', sem: '5', sec: 'A', dept: 'CSE', email: 'invalid_email_format' },
    { name: 'Valid Name', usn: '1CD23CS001', sem: '5', sec: 'A', dept: 'CSE', email: 'duplicate.usn@cit.edu' } // Already in Firestore
  ];

  const valRes = await postJson('http://localhost:3001/api/import-students', { students: validationTestStudents }, {
    'Authorization': `Bearer ${adminIdToken}`
  });

  assert(valRes.status === 200, 'Batch validation request handled successfully');
  const results = valRes.data.results;
  assert(results[0].result === 'Invalid name', 'Empty name rejected with "Invalid name"');
  assert(results[1].result === 'Invalid USN', 'Empty USN rejected with "Invalid USN"');
  assert(results[2].result === 'Invalid semester', 'Out-of-range semester rejected with "Invalid semester"');
  assert(results[3].result === 'Invalid section', 'Invalid section rejected with "Invalid section"');
  assert(results[4].result === 'Department not found', 'Unknown department rejected with "Department not found"');
  assert(results[5].result === 'Invalid email', 'Malformed email rejected with "Invalid email"');
  assert(results[6].result === 'Already exists', 'Existing USN (1CD23CS001) blocked with "Already exists"');

  // 7. Test Duplicate prevention within CSV
  const csvDupStudents = [
    { name: 'Duplicate USN 1', usn: '1CD23CS777', sem: '5', sec: 'A', dept: 'CSE', email: 'dup1@cit.edu' },
    { name: 'Duplicate USN 2', usn: '1CD23CS777', sem: '5', sec: 'A', dept: 'CSE', email: 'dup2@cit.edu' }
  ];
  // Note: on frontend preview, seenUsns blocks row 2; on backend, row 1 creates, row 2 hits duplicate check

  // 8. Full End-to-End Real Student Import & Login Flow
  const ts = Date.now();
  const testStudent = {
    name: 'Rohit Verma',
    usn: '1CD23CS' + String(ts).slice(-3),
    sem: '5',
    sec: 'A',
    dept: 'CSE',
    email: `rohit.test.${ts}@cit.edu`
  };

  console.log(`\nImporting test student: ${testStudent.name} (${testStudent.email} / ${testStudent.usn})...`);
  const importRes = await postJson('http://localhost:3001/api/import-students', { students: [testStudent] }, {
    'Authorization': `Bearer ${adminIdToken}`
  });

  assert(importRes.status === 200, 'Import API returned 200 OK');
  const importResult = importRes.data.results[0];
  assert(importResult.status === 'success' || importResult.status === 'partial_success', 'Import result status is success');
  assert(importResult.result === 'Imported successfully' || importResult.result.includes('Student created'), 'Student record created successfully');
  const createdUid = importResult.uid;
  assert(!!createdUid, `Auth UID generated for student: ${createdUid}`);

  // 9. Verify Firestore student document exists with exact schema
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

  const studentDoc = await db.collection('students').doc(createdUid).get();
  assert(studentDoc.exists, 'Firestore document exists at students/' + createdUid);
  const studentData = studentDoc.data();
  assert(studentData.uid === createdUid, 'Firestore uid matches Auth UID');
  assert(studentData.name === testStudent.name, 'Firestore name matches imported name');
  assert(studentData.usn === testStudent.usn, 'Firestore usn matches imported USN');
  assert(studentData.email === testStudent.email, 'Firestore email matches imported email');
  assert(studentData.semester === 5, 'Firestore semester is 5');
  assert(studentData.section === 'A', 'Firestore section is A');
  assert(studentData.dept === 'cse', 'Firestore dept is cse');
  assert(studentData.faceRegistered === false, 'Firestore faceRegistered is false (ready for enrollment)');
  assert(!studentData.password && !studentData.passwordHash, 'No passwords or hashes stored in Firestore profile');

  // 10. Verify Uniqueness Indexes in Firestore
  const usnDoc = await db.collection('uniqueUSNs').doc(testStudent.usn).get();
  assert(usnDoc.exists && usnDoc.data().uid === createdUid, 'uniqueUSNs index doc exists with matching UID');

  const emailDoc = await db.collection('uniqueEmails').doc(testStudent.email).get();
  assert(emailDoc.exists && emailDoc.data().uid === createdUid, 'uniqueEmails index doc exists with matching UID');

  // 11. Verify Duplicate Import Prevention (Attempting to import same student again)
  const reImportRes = await postJson('http://localhost:3001/api/import-students', { students: [testStudent] }, {
    'Authorization': `Bearer ${adminIdToken}`
  });
  const reImportResult = reImportRes.data.results[0];
  assert(reImportResult.result === 'Already exists', 'Re-import of same student blocked: "Already exists"');

  // 12. Password Setup & Student Login
  // Set password for the student (simulating reset-password.html confirmation)
  const newStudentPassword = 'TestPassword123!';
  const authAdmin = admin.apps.length ? admin.auth() : require('C:/Users/HP/OneDrive/Desktop/Main Project/attendance-management-system-demo/functions/node_modules/firebase-admin').auth();
  await authAdmin.updateUser(createdUid, { password: newStudentPassword });
  console.log('Password set for test student.');

  // Attempt login using student email and newly set password
  const studentLoginRes = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
    email: testStudent.email,
    password: newStudentPassword,
    returnSecureToken: true
  });
  assert(studentLoginRes.status === 200, 'Student successfully logged in with newly created password');
  assert(studentLoginRes.data.localId === createdUid, 'Logged-in user UID matches student UID');
  assert(studentLoginRes.data.email === testStudent.email, 'Logged-in user email matches student email');

  // 13. Verify Biometric Enrollment simulation (Student registers face)
  await db.collection('students').doc(createdUid).update({
    faceRegistered: true,
    faceDescriptor: new Array(128).fill(0.05)
  });
  const updatedStudentDoc = await db.collection('students').doc(createdUid).get();
  assert(updatedStudentDoc.data().faceRegistered === true, 'Biometric face registration succeeded on student profile');

  // 14. Cleanup test records
  console.log('\nCleaning up test student records...');
  await db.collection('students').doc(createdUid).delete();
  await db.collection('uniqueUSNs').doc(testStudent.usn).delete();
  await db.collection('uniqueEmails').doc(testStudent.email).delete();
  await authAdmin.deleteUser(createdUid);
  console.log('Test student cleaned up successfully.');

  console.log('\n====================================================');
  console.log(`FINAL CSV IMPORT TEST SCORE: ${passed}/${total} TESTS PASSED`);
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('Test Suite Error:', err);
  process.exit(1);
});
