const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('./functions/node_modules/firebase-admin');
const { Firestore } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');

const PORT = process.env.BACKEND_PORT || 3001;
const PROJECT_ID = 'clound-based-attendance';
const WEB_API_KEY = 'AIzaSyC1x0R-CKUh7sGonAYiqXMNemeLW-6bdvU';

// 1. Initialize Firebase Admin SDK
let db = null;
let FieldValue = null;
try {
  const credPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (fs.existsSync(credPath)) {
    const credData = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = credData.tokens?.access_token;
    if (token) {
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: token });

      admin.initializeApp({
        projectId: PROJECT_ID,
        credential: {
          getAccessToken: () => Promise.resolve({ access_token: token, expires_in: 3600 })
        }
      });
      db = new Firestore({
        projectId: PROJECT_ID,
        authClient: authClient
      });
      FieldValue = db.constructor.FieldValue;
      console.log('[Backend] Initialized Firebase Admin & Firestore via CLI token');
    }
  }
} catch (initErr) {
  console.warn('[Backend] CLI token init failed, attempting standard initializeApp:', initErr.message);
}

const existingApps = typeof admin.getApps === 'function' ? admin.getApps() : (admin.apps || []);
if (!existingApps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
  FieldValue = db.constructor.FieldValue || admin.firestore.FieldValue;
  console.log('[Backend] Initialized standard Firebase Admin');
}

if (!FieldValue && db) {
  FieldValue = (db.constructor && db.constructor.FieldValue) || (admin.firestore ? admin.firestore.FieldValue : require('@google-cloud/firestore').FieldValue);
}

async function isAdminAuth(decodedToken) {
  if (!decodedToken) return false;
  if (decodedToken.admin === true) return true;
  const uid = decodedToken.uid || decodedToken.user_id;
  if (!uid) return false;
  try {
    const adminDoc = await db.collection('admins').doc(uid).get();
    return adminDoc.exists && adminDoc.data()?.active !== false;
  } catch (err) {
    console.error('[Backend] Error verifying admin doc for UID:', uid, err.message);
    return false;
  }
}

function triggerPasswordResetEmail(email) {
  return new Promise(resolve => {
    const postData = JSON.stringify({
      requestType: 'PASSWORD_RESET',
      email: email
    });
    const req = https.request(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          try {
            const errObj = JSON.parse(data);
            resolve({ ok: false, error: errObj.error?.message || `HTTP ${res.statusCode}` });
          } catch(e) {
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          }
        }
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timeout' }); });
    req.write(postData);
    req.end();
  });
}

async function loadDepartmentsMap() {
  const snap = await db.collection('departments').get();
  const map = new Map();
  snap.forEach(doc => {
    const data = doc.data();
    const id = doc.id;
    const name = (data.name || id).trim();
    const normalizedName = (data.normalizedName || name).toLowerCase();
    const item = { id, name, normalizedName };
    map.set(id.toLowerCase(), item);
    map.set(normalizedName, item);
    map.set(name.toLowerCase(), item);
  });
  return map;
}

async function importSingleStudent(student, departmentsMap) {
  const name = String(student.name || '').trim();
  const usn = String(student.usn || '').trim().toUpperCase();
  const email = String(student.email || '').trim().toLowerCase();
  const semRaw = student.sem;
  const sec = String(student.sec || '').trim().toUpperCase();
  const deptInput = String(student.dept || '').trim();

  // 1. Validation
  if (!name) {
    return { name, usn, email, status: 'failed', result: 'Invalid name', reason: 'Student name cannot be empty' };
  }
  if (!usn) {
    return { name, usn, email, status: 'failed', result: 'Invalid USN', reason: 'Student USN cannot be empty' };
  }
  const sem = parseInt(semRaw, 10);
  if (isNaN(sem) || sem < 1 || sem > 8) {
    return { name, usn, email, status: 'failed', result: 'Invalid semester', reason: 'Semester must be between 1 and 8' };
  }
  if (!sec || !['A', 'B', 'C', 'D'].includes(sec)) {
    return { name, usn, email, status: 'failed', result: 'Invalid section', reason: 'Section must be A, B, C, or D' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return { name, usn, email, status: 'failed', result: 'Invalid email', reason: 'Invalid email format' };
  }

  // Department check against existing departments
  const normalizedDeptKey = deptInput.toLowerCase();
  let matchedDept = departmentsMap.get(normalizedDeptKey);
  if (!matchedDept) {
    for (const [key, d] of departmentsMap.entries()) {
      if (d.id.toLowerCase() === normalizedDeptKey || d.name.toLowerCase() === normalizedDeptKey || (d.normalizedName && d.normalizedName.toLowerCase() === normalizedDeptKey)) {
        matchedDept = d;
        break;
      }
    }
  }
  if (!matchedDept) {
    return { name, usn, email, status: 'failed', result: 'Department not found', reason: `Department "${deptInput}" does not match an existing department` };
  }

  const deptId = matchedDept.id;
  const deptName = matchedDept.name;

  // 2. Duplicate Checks
  try {
    // USN duplicate check
    const usnDoc = await db.collection('uniqueUSNs').doc(usn).get();
    if (usnDoc.exists) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }
    const usnSnap = await db.collection('students').where('usn', '==', usn).limit(1).get();
    if (!usnSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }

    // Email duplicate check
    const emailDoc = await db.collection('uniqueEmails').doc(email).get();
    if (emailDoc.exists) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Account with email ${email} already exists` };
    }
    const emailSnap = await db.collection('students').where('email', '==', email).limit(1).get();
    if (!emailSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with email ${email} already exists` };
    }

    // Auth user check
    try {
      const existingUser = await admin.auth().getUserByEmail(email);
      if (existingUser) {
        return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Firebase Authentication account already exists for ${email}` };
      }
    } catch (authLookupErr) {
      if (authLookupErr.code !== 'auth/user-not-found') {
        throw authLookupErr;
      }
    }
  } catch (checkErr) {
    return { name, usn, email, status: 'failed', result: 'Validation error', reason: checkErr.message || 'Error checking existing records' };
  }

  // 3. Create Firebase Authentication Account
  let authUser = null;
  try {
    authUser = await admin.auth().createUser({
      email: email,
      displayName: name
    });
  } catch (authCreateErr) {
    if (authCreateErr.code === 'auth/email-already-in-use') {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: 'Firebase Authentication account already exists' };
    }
    return { name, usn, email, status: 'failed', result: 'Authentication account creation failed', reason: authCreateErr.message };
  }

  const uid = authUser.uid;

  // 4. Create Firestore Student Profile and Unique Index Records
  const FieldValue = (db && db.constructor && db.constructor.FieldValue)
    ? db.constructor.FieldValue
    : (admin.firestore ? admin.firestore.FieldValue : require('@google-cloud/firestore').FieldValue);
  const studentDoc = {
    uid: uid,
    name: name,
    usn: usn,
    phone: student.phone || '',
    email: email,
    dept: deptId,
    department: deptName || deptId,
    semester: sem,
    section: sec,
    faceRegistered: false,
    createdAt: FieldValue.serverTimestamp(),
    approvedAt: FieldValue.serverTimestamp()
  };

  try {
    const batch = db.batch();
    batch.set(db.collection('uniqueEmails').doc(email), {
      email: email,
      uid: uid,
      role: 'student',
      createdAt: FieldValue.serverTimestamp()
    });
    batch.set(db.collection('uniqueUSNs').doc(usn), {
      usn: usn,
      uid: uid,
      role: 'student',
      createdAt: FieldValue.serverTimestamp()
    });
    batch.set(db.collection('students').doc(uid), studentDoc);
    await batch.commit();
  } catch (firestoreErr) {
    // Rollback created Firebase Auth account
    try {
      await admin.auth().deleteUser(uid);
      console.warn(`[Rollback] Deleted orphaned Auth user ${uid} after Firestore commit failure.`);
    } catch (rollbackErr) {
      console.error(`[Rollback Error] Failed to delete Auth user ${uid}:`, rollbackErr);
    }
    return { name, usn, email, status: 'failed', result: 'Student profile creation failed', reason: firestoreErr.message };
  }

  // 5. Auto-Enroll in matching subjects for Dept + Semester + Section
  try {
    const subjectsSnap = await db.collection('subjects').get();
    const enrollBatch = db.batch();
    let enrollCount = 0;

    subjectsSnap.forEach(subDoc => {
      const sub = subDoc.data();
      const subDept = String(sub.departmentId || sub.department || '').trim().toLowerCase();
      const stuDeptId = String(deptId).trim().toLowerCase();
      const stuDeptName = String(deptName).trim().toLowerCase();
      const deptMatches = subDept === stuDeptId || subDept === stuDeptName;
      const semMatches = parseInt(sub.semester, 10) === sem;
      const secMatches = !sub.section || String(sub.section).trim().toUpperCase() === sec;

      if (deptMatches && semMatches && secMatches) {
        const roster = Array.isArray(sub.enrolledRoster) ? sub.enrolledRoster : [];
        const alreadyIn = roster.some(r => r && (r.id === uid || r.uid === uid));
        const updatedRoster = alreadyIn ? roster : [...roster, { id: uid, name: name, usn: usn }];
        enrollBatch.update(subDoc.ref, {
          studentIds: FieldValue.arrayUnion(uid),
          enrolledRoster: updatedRoster
        });
        enrollCount++;
      }
    });

    if (enrollCount > 0) {
      await enrollBatch.commit();
    }
  } catch (enrollErr) {
    console.warn(`[Auto-Enroll] Warning during subject enrollment for student ${uid}:`, enrollErr);
  }

  // 6. Trigger Password Setup Email
  let emailSent = false;
  let emailError = null;
  try {
    const emailResult = await triggerPasswordResetEmail(email);
    if (emailResult.ok) {
      emailSent = true;
    } else {
      emailError = emailResult.error;
    }
  } catch (emailEx) {
    emailError = emailEx.message;
  }

  if (emailSent) {
    return {
      name,
      usn,
      email,
      uid,
      status: 'success',
      result: 'Imported successfully',
      reason: null,
      emailSent: true
    };
  } else {
    return {
      name,
      usn,
      email,
      uid,
      status: 'partial_success',
      result: 'Student created, but password setup email could not be sent.',
      reason: emailError ? `Email error: ${emailError}` : 'Password setup email could not be dispatched',
      emailSent: false
    };
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cit-smart-attendance-backend', port: PORT }));
    return;
  }

  if (url.pathname === '/api/import-students' && req.method === 'POST') {
    try {
      // 1. Authenticate Request via Firebase ID Token
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();

      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authorization token required. Only authenticated administrators may import students.' }));
        return;
      }

      let decodedToken = null;
      try {
        decodedToken = await admin.auth().verifyIdToken(token);
      } catch (tokenErr) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired administrator token: ' + tokenErr.message }));
        return;
      }

      const isAuthorizedAdmin = await isAdminAuth(decodedToken);
      if (!isAuthorizedAdmin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden. Only authorized institutional administrators may import students.' }));
        return;
      }

      // 2. Parse Body
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }
      const body = JSON.parse(bodyStr || '{}');
      const students = Array.isArray(body.students) ? body.students : [];

      if (!students.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No student records provided for import.' }));
        return;
      }

      // 3. Process Each Student Row Independently
      const departmentsMap = await loadDepartmentsMap();
      const results = [];
      let importedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const stu of students) {
        const rowResult = await importSingleStudent(stu, departmentsMap);
        results.push(rowResult);
        if (rowResult.status === 'success' || rowResult.status === 'partial_success') {
          importedCount++;
        } else if (rowResult.status === 'skipped') {
          skippedCount++;
        } else {
          failedCount++;
        }
      }

      const summary = {
        total: students.length,
        imported: importedCount,
        failed: failedCount,
        skipped: skippedCount
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        summary,
        results
      }));
    } catch (err) {
      console.error('[Backend Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal server error during student import' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`CIT Secure Backend Server running on http://localhost:${PORT}`);
});

module.exports = { server, importSingleStudent, triggerPasswordResetEmail, isAdminAuth };
