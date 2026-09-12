const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const https = require('https');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const db = admin.firestore();
const FieldValue = (db && db.constructor && db.constructor.FieldValue) ? db.constructor.FieldValue : admin.firestore.FieldValue;
const DELETE_BATCH_SIZE = 400;

async function isAdmin(auth) {
  if (!auth) return false;
  if (auth.token?.admin === true) return true;
  const uid = auth.uid;
  if (!uid) return false;
  try {
    const adminDoc = await db.collection('admins').doc(uid).get();
    return adminDoc.exists && adminDoc.data()?.active !== false;
  } catch (err) {
    console.error('[Functions] Error checking admin doc for UID:', uid, err);
    return false;
  }
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasReference(data, field, value) {
  return data && data[field] === value;
}

async function queryByFields(collectionName, queries) {
  const snapshots = await Promise.all(queries.map(({ field, operator = '==', value }) =>
    db.collection(collectionName).where(field, operator, value).get()));
  const documents = new Map();
  snapshots.forEach(snapshot => snapshot.forEach(doc => documents.set(doc.id, doc)));
  return Array.from(documents.values());
}

async function commitOperations(operations) {
  for (let index = 0; index < operations.length; index += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    operations.slice(index, index + DELETE_BATCH_SIZE).forEach(operation => {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else batch.update(operation.ref, operation.data);
    });
    await batch.commit();
  }
}

function removeFacultyFields() {
  return {
    facultyId: FieldValue.delete(),
    facultyUid: FieldValue.delete(),
    facultyName: FieldValue.delete()
  };
}

async function deleteStudent(uid) {
  const profileRef = db.collection('students').doc(uid);
  const profile = await profileRef.get();
  if (!profile.exists) return deleteAuthOnly(uid, 'student');

  const student = profile.data();
  const operations = [{ type: 'delete', ref: profileRef }];
  const [subjects, attendance, corrections, requests, emails] = await Promise.all([
    queryByFields('subjects', [{ field: 'studentIds', operator: 'array-contains', value: uid }]),
    queryByFields('attendance', [{ field: 'studentUid', value: uid }, { field: 'studentId', value: uid }]),
    queryByFields('attendanceCorrectionRequests', [{ field: 'studentUid', value: uid }, { field: 'studentId', value: uid }]),
    queryByFields('registrationRequests', [{ field: 'uid', value: uid }, { field: 'approvedAccountId', value: uid }]),
    queryByFields('uniqueEmails', [{ field: 'uid', value: uid }])
  ]);

  subjects.forEach(doc => {
    const data = doc.data();
    const ids = Array.isArray(data.studentIds) ? data.studentIds : [];
    const roster = Array.isArray(data.enrolledRoster) ? data.enrolledRoster : [];
    if (ids.includes(uid) || roster.some(item => item && (item.id === uid || item.uid === uid))) {
      operations.push({
        type: 'update',
        ref: doc.ref,
        data: {
          studentIds: ids.filter(id => id !== uid),
          enrolledRoster: roster.filter(item => item && item.id !== uid && item.uid !== uid)
        }
      });
    }
  });

  attendance.forEach(doc => {
    const data = doc.data();
    if (data.studentUid === uid || data.studentId === uid || doc.id.endsWith(`_${uid}`)) {
      operations.push({ type: 'delete', ref: doc.ref });
    }
  });

  corrections.forEach(doc => {
    const data = doc.data();
    if (data.studentUid === uid || data.studentId === uid) operations.push({ type: 'delete', ref: doc.ref });
  });

  requests.forEach(doc => {
    const data = doc.data();
    if (data.uid === uid || data.approvedAccountId === uid) operations.push({ type: 'delete', ref: doc.ref });
  });

  emails.forEach(doc => {
    if (doc.data().uid === uid || doc.id === String(student.email || '').toLowerCase()) {
      operations.push({ type: 'delete', ref: doc.ref });
    }
  });
  if (student.usn) operations.push({ type: 'delete', ref: db.collection('uniqueUSNs').doc(student.usn) });

  await commitOperations(operations);
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    throw new HttpsError('failed-precondition', 'Firestore data was deleted, but the Firebase Authentication account could not be deleted.', {
      uid,
      authError: error.code || 'unknown'
    });
  }
  return { deletedType: 'student', deletedId: uid, authDeleted: true };
}

async function deleteFaculty(uid) {
  const profileRef = db.collection('faculty').doc(uid);
  const profile = await profileRef.get();
  if (!profile.exists) return deleteAuthOnly(uid, 'faculty');

  const faculty = profile.data();
  const operations = [{ type: 'delete', ref: profileRef }];
  const [subjects, timetable, sessions, corrections, attendance, emails, requests] = await Promise.all([
    queryByFields('subjects', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('timetable', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('attendanceSessions', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('attendanceCorrectionRequests', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('attendance', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('uniqueEmails', [{ field: 'uid', value: uid }]),
    queryByFields('registrationRequests', [{ field: 'uid', value: uid }, { field: 'approvedAccountId', value: uid }])
  ]);

  subjects.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  timetable.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  sessions.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  corrections.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  attendance.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  emails.forEach(doc => {
    if (doc.data().uid === uid || doc.id === String(faculty.email || '').toLowerCase()) operations.push({ type: 'delete', ref: doc.ref });
  });
  requests.forEach(doc => {
    const data = doc.data();
    if (data.uid === uid || data.approvedAccountId === uid) operations.push({ type: 'delete', ref: doc.ref });
  });

  await commitOperations(operations);
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    throw new HttpsError('failed-precondition', 'Firestore data was deleted, but the Firebase Authentication account could not be deleted.', {
      uid,
      authError: error.code || 'unknown'
    });
  }
  return { deletedType: 'faculty', deletedId: uid, authDeleted: true };
}

async function deleteAuthOnly(uid, type) {
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return { deletedType: type, deletedId: uid, authDeleted: true };
    }
    throw new HttpsError('failed-precondition', 'The profile is already gone, but the Firebase Authentication account could not be deleted.', {
      uid,
      authError: error.code || 'unknown'
    });
  }
  return { deletedType: type, deletedId: uid, authDeleted: true };
}

async function deleteSubject(subjectId) {
  const subjectRef = db.collection('subjects').doc(subjectId);
  const subject = await subjectRef.get();
  if (!subject.exists) throw new HttpsError('not-found', 'Subject was not found.');
  const data = subject.data();
  const operations = [
    { type: 'delete', ref: subjectRef }
  ];
  const [timetable, sessions, attendance, corrections] = await Promise.all([
    queryByFields('timetable', [{ field: 'subjectId', value: subjectId }]),
    queryByFields('attendanceSessions', [{ field: 'subjectId', value: subjectId }]),
    queryByFields('attendance', [{ field: 'subjectId', value: subjectId }]),
    queryByFields('attendanceCorrectionRequests', [{ field: 'subjectId', value: subjectId }])
  ]);
  [timetable, sessions, attendance, corrections].forEach(docs => docs.forEach(doc => {
    if (doc.data().subjectId === subjectId) operations.push({ type: 'delete', ref: doc.ref });
  }));
  if (data.normalizedCode) operations.push({ type: 'delete', ref: db.collection('uniqueSubjectCodes').doc(data.normalizedCode) });
  if (data.offeringKey) operations.push({ type: 'delete', ref: db.collection('uniqueOfferings').doc(data.offeringKey) });
  await commitOperations(operations);
  return { deletedType: 'subject', deletedId: subjectId, authDeleted: false };
}

async function deleteDepartment(departmentId) {
  const departmentRef = db.collection('departments').doc(departmentId);
  const department = await departmentRef.get();
  if (!department.exists) throw new HttpsError('not-found', 'Department was not found.');
  const [students, faculty, subjects, timetable] = await Promise.all([
    queryByFields('students', [{ field: 'dept', value: departmentId }, { field: 'department', value: departmentId }]),
    queryByFields('faculty', [{ field: 'department', value: departmentId }]),
    queryByFields('subjects', [{ field: 'departmentId', value: departmentId }, { field: 'department', value: departmentId }]),
    queryByFields('timetable', [{ field: 'departmentId', value: departmentId }, { field: 'department', value: departmentId }])
  ]);
  const hasChildren = students.some(doc => [doc.data().dept, doc.data().department].includes(departmentId)) ||
    faculty.some(doc => doc.data().department === departmentId) ||
    subjects.some(doc => [doc.data().departmentId, doc.data().department].includes(departmentId)) ||
    timetable.some(doc => [doc.data().departmentId, doc.data().department].includes(departmentId));
  if (hasChildren) throw new HttpsError('failed-precondition', 'Department still has dependent records. Delete or reassign those records first.');
  await departmentRef.delete();
  return { deletedType: 'department', deletedId: departmentId, authDeleted: false };
}

async function deleteEntity(type, id) {
  if (!asString(id)) throw new HttpsError('invalid-argument', 'A target document ID is required.');
  if (type === 'student') return deleteStudent(id);
  if (type === 'faculty') return deleteFaculty(id);
  if (type === 'subject') return deleteSubject(id);
  if (type === 'department') return deleteDepartment(id);
  if (type === 'timetable' || type === 'settings') {
    const collection = type === 'timetable' ? 'timetable' : 'settings';
    const ref = db.collection(collection).doc(id);
    if (!(await ref.get()).exists) throw new HttpsError('not-found', `${type} record was not found.`);
    await ref.delete();
    return { deletedType: type, deletedId: id, authDeleted: false };
  }
  throw new HttpsError('invalid-argument', `Unsupported deletion type: ${type}`);
}

exports.deleteAdminEntity = onCall(async request => {
  if (!request.auth || !(await isAdmin(request.auth))) {
    throw new HttpsError('permission-denied', 'Only an authenticated Admin may permanently delete records.');
  }
  const type = asString(request.data?.type);
  const id = asString(request.data?.id);
  return deleteEntity(type, id);
});

const WEB_API_KEY = 'AIzaSyC1x0R-CKUh7sGonAYiqXMNemeLW-6bdvU';

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
          } catch (e) {
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

  // Department match against existing departments
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

  // 2. Duplicate checks (Firestore indexes & Auth)
  try {
    const usnDoc = await db.collection('uniqueUSNs').doc(usn).get();
    if (usnDoc.exists) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }
    const usnSnap = await db.collection('students').where('usn', '==', usn).limit(1).get();
    if (!usnSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }

    const emailDoc = await db.collection('uniqueEmails').doc(email).get();
    if (emailDoc.exists) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Account with email ${email} already exists` };
    }
    const emailSnap = await db.collection('students').where('email', '==', email).limit(1).get();
    if (!emailSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with email ${email} already exists` };
    }

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
    try {
      await admin.auth().deleteUser(uid);
      console.warn(`[Rollback] Deleted orphaned Auth user ${uid} after Firestore commit failure.`);
    } catch (rollbackErr) {
      console.error(`[Rollback Error] Failed to delete Auth user ${uid}:`, rollbackErr);
    }
    return { name, usn, email, status: 'failed', result: 'Student profile creation failed', reason: firestoreErr.message };
  }

  // 5. Auto-enroll in matching subjects for Dept + Semester + Section
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

exports.importStudents = onCall(async request => {
  if (!request.auth || !(await isAdmin(request.auth))) {
    throw new HttpsError('permission-denied', 'Only an authenticated Admin may import students.');
  }

  const rawStudents = request.data?.students;
  const students = Array.isArray(rawStudents) ? rawStudents : (rawStudents ? [rawStudents] : []);

  if (!students.length) {
    throw new HttpsError('invalid-argument', 'No student records provided for import.');
  }

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

  return {
    success: true,
    summary: {
      total: students.length,
      imported: importedCount,
      failed: failedCount,
      skipped: skippedCount
    },
    results
  };
});

