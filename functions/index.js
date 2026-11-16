const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const https = require('https');
const crypto = require('crypto');

const app = getApps().length ? getApps()[0] : initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const auth = getAuth(app);
const db = getFirestore(app);
const DELETE_BATCH_SIZE = 400;
const MAX_IMPORTED_STUDENTS = 500;

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

function distanceMeters(latitude1, longitude1, latitude2, longitude2) {
  const toRadians = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const deltaLatitude = toRadians(latitude2 - latitude1);
  const deltaLongitude = toRadians(longitude2 - longitude1);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2))
    * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

async function reserveStudentKeys(usn, email) {
  const reservationId = crypto.randomUUID();
  const usnRef = db.collection('uniqueUSNs').doc(usn);
  const emailRef = db.collection('uniqueEmails').doc(email);
  const result = await db.runTransaction(async transaction => {
    const [usnSnap, emailSnap] = await transaction.getAll(usnRef, emailRef);
    if (usnSnap.exists) return { reserved: false, reason: `Student with USN ${usn} already exists` };
    if (emailSnap.exists) return { reserved: false, reason: `Account with email ${email} already exists` };
    transaction.create(usnRef, {
      usn,
      role: 'student',
      reservationId,
      status: 'reserving',
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(emailRef, {
      email,
      role: 'student',
      reservationId,
      status: 'reserving',
      createdAt: FieldValue.serverTimestamp()
    });
    return { reserved: true, reservationId, usnRef, emailRef };
  });
  return result;
}

async function releaseStudentKeyReservation(reservation) {
  if (!reservation?.reserved) return;
  await db.runTransaction(async transaction => {
    const [usnSnap, emailSnap] = await transaction.getAll(reservation.usnRef, reservation.emailRef);
    if (usnSnap.exists && usnSnap.data().reservationId === reservation.reservationId) {
      transaction.delete(reservation.usnRef);
    }
    if (emailSnap.exists && emailSnap.data().reservationId === reservation.reservationId) {
      transaction.delete(reservation.emailRef);
    }
  });
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

async function resolveStudentDeletionTarget(identifier, suppliedUid = '') {
  const identifierValue = asString(identifier);
  const suppliedUidValue = asString(suppliedUid);
  if (!identifierValue && !suppliedUidValue) {
    throw new HttpsError('invalid-argument', 'A student record and Authentication UID are required.');
  }

  const candidateUid = suppliedUidValue || identifierValue;
  const candidateRef = db.collection('students').doc(identifierValue || candidateUid);
  const candidateSnap = await candidateRef.get();
  if (candidateSnap.exists) {
    const data = candidateSnap.data();
    const profileUid = asString(data.uid) || candidateUid;
    return { uid: profileUid, profileRef: candidateRef, profile: data };
  }

  if (suppliedUidValue && suppliedUidValue !== identifierValue) {
    const uidRef = db.collection('students').doc(suppliedUidValue);
    const uidSnap = await uidRef.get();
    if (uidSnap.exists) {
      return { uid: suppliedUidValue, profileRef: uidRef, profile: uidSnap.data() };
    }
  }

  return { uid: candidateUid, profileRef: candidateRef, profile: null };
}

async function deleteStudent(identifier, suppliedUid = '') {
  const target = await resolveStudentDeletionTarget(identifier, suppliedUid);
  const { uid, profileRef, profile } = target;
  let authDeleted = false;

  try {
    await auth.getUser(uid);
    await auth.deleteUser(uid);
    authDeleted = true;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      // Idempotent retry: Auth is already gone, so finish any remaining cleanup.
      authDeleted = true;
    } else {
      console.error('[Functions] Student Auth deletion preflight failed:', {
        code: error.code || 'unknown',
        operation: 'deleteStudent'
      });
      throw new HttpsError('failed-precondition', 'The Firebase Authentication account could not be deleted. No Firestore data was changed.');
    }
  }

  if (!profile) {
    return { deletedType: 'student', deletedId: identifier || uid, authDeleted };
  }

  const student = profile;
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

  try {
    await commitOperations(operations);
  } catch (error) {
    console.error('[Functions] Student Firestore cleanup failed after Auth deletion:', {
      code: error.code || 'unknown',
      operation: 'deleteStudent'
    });
    throw new HttpsError('failed-precondition', 'Authentication was deleted, but some Firestore cleanup could not be completed. Retry the same deletion.');
  }
  return { deletedType: 'student', deletedId: identifier || uid, authDeleted };
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

  try {
    await auth.getUser(uid);
    await auth.deleteUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') {
      console.error('[Functions] Faculty Auth deletion failed before Firestore cleanup:', {
        code: error.code || 'unknown',
        operation: 'deleteFaculty'
      });
      throw new HttpsError('failed-precondition', 'The Firebase Authentication account could not be deleted. No Firestore data was changed.');
    }
  }
  try {
    await commitOperations(operations);
  } catch (error) {
    console.error('[Functions] Faculty Firestore cleanup failed after Auth deletion:', {
      code: error.code || 'unknown',
      operation: 'deleteFaculty'
    });
    throw new HttpsError('failed-precondition', 'Authentication was deleted, but some Firestore cleanup could not be completed. Retry the same deletion.');
  }
  return { deletedType: 'faculty', deletedId: uid, authDeleted: true };
}

async function deleteAuthOnly(uid, type) {
  try {
    await auth.deleteUser(uid);
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

async function deleteEntity(type, id, authUid = '') {
  if (!asString(id)) throw new HttpsError('invalid-argument', 'A target document ID is required.');
  if (type === 'student') return deleteStudent(id, authUid);
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
  const authUid = asString(request.data?.authUid);
  return deleteEntity(type, id, authUid);
});

const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

function triggerPasswordResetEmail(email) {
  if (!WEB_API_KEY) {
    return Promise.resolve({ ok: false, error: 'FIREBASE_WEB_API_KEY is not configured.' });
  }
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

async function importSingleStudent(student, departmentsMap, cachedSubjects = null) {
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
  const matchedDept = departmentsMap.get(normalizedDeptKey);
  if (!matchedDept) {
    return { name, usn, email, status: 'failed', result: 'Department not found', reason: `Department "${deptInput}" does not match an existing department` };
  }

  const deptId = matchedDept.id;
  const deptName = matchedDept.name;

  // 2. Duplicate checks and atomic uniqueness reservation
  let keyReservation = null;
  try {
    const usnSnap = await db.collection('students').where('usn', '==', usn).limit(1).get();
    if (!usnSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }

    const emailSnap = await db.collection('students').where('email', '==', email).limit(1).get();
    if (!emailSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with email ${email} already exists` };
    }

    try {
      const existingUser = await auth.getUserByEmail(email);
      if (existingUser) {
        return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Firebase Authentication account already exists for ${email}` };
      }
    } catch (authLookupErr) {
      if (authLookupErr.code !== 'auth/user-not-found') {
        throw authLookupErr;
      }
    }
    keyReservation = await reserveStudentKeys(usn, email);
    if (!keyReservation.reserved) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: keyReservation.reason };
    }
  } catch (checkErr) {
    return { name, usn, email, status: 'failed', result: 'Validation error', reason: checkErr.message || 'Error checking existing records' };
  }

  // 3. Create Firebase Authentication Account
  let authUser = null;
  try {
    authUser = await auth.createUser({
      email: email,
      displayName: name
    });
  } catch (authCreateErr) {
    if (authCreateErr.code === 'auth/email-already-in-use') {
      await releaseStudentKeyReservation(keyReservation);
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: 'Firebase Authentication account already exists' };
    }
    await releaseStudentKeyReservation(keyReservation);
    return { name, usn, email, status: 'failed', result: 'Authentication account creation failed', reason: authCreateErr.message };
  }

  const uid = authUser.uid;

  // 4. Create Firestore Student Profile and Unique Index Records
  const parentName = String(student.parentName || student.guardianName || `${name}'s Parent`).trim();
  const rawParentPhone = String(student.parentPhone || student.parentMobile || student.phone || '9876543210').trim();
  // Basic Indian phone normalization
  let parentPhoneNorm = rawParentPhone.replace(/[\s\-().]/g, '');
  if (parentPhoneNorm.startsWith('+91')) parentPhoneNorm = parentPhoneNorm.slice(3);
  else if (parentPhoneNorm.startsWith('91') && parentPhoneNorm.length === 12) parentPhoneNorm = parentPhoneNorm.slice(2);
  else if (parentPhoneNorm.startsWith('0') && parentPhoneNorm.length === 11) parentPhoneNorm = parentPhoneNorm.slice(1);
  const parentPhone = /^[6-9]\d{9}$/.test(parentPhoneNorm) ? parentPhoneNorm : '9876543210';

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
    parentName: parentName,
    parentPhone: parentPhone,
    smsEnabled: student.smsEnabled !== false,
    faceRegistered: false,
    createdAt: FieldValue.serverTimestamp(),
    approvedAt: FieldValue.serverTimestamp()
  };

  try {
    const batch = db.batch();
    batch.update(keyReservation.emailRef, {
      email: email,
      uid: uid,
      role: 'student',
      status: 'active'
    });
    batch.update(keyReservation.usnRef, {
      usn: usn,
      uid: uid,
      role: 'student',
      status: 'active'
    });
    batch.set(db.collection('students').doc(uid), studentDoc);
    await batch.commit();
  } catch (firestoreErr) {
    try {
      await auth.deleteUser(uid);
      console.warn(`[Rollback] Deleted orphaned Auth user ${uid} after Firestore commit failure.`);
    } catch (rollbackErr) {
      console.error(`[Rollback Error] Failed to delete Auth user ${uid}:`, rollbackErr);
    }
    await releaseStudentKeyReservation(keyReservation);
    return { name, usn, email, status: 'failed', result: 'Student profile creation failed', reason: firestoreErr.message };
  }

  // 5. Auto-enroll in matching subjects for Dept + Semester + Section
  try {
    const subjectsList = cachedSubjects || (await db.collection('subjects').get()).docs.map(d => ({ ref: d.ref, data: d.data() }));
    let enrollBatch = db.batch();
    let enrollCount = 0;

    for (const subItem of subjectsList) {
      const sub = subItem.data;
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
        enrollBatch.update(subItem.ref, {
          studentIds: FieldValue.arrayUnion(uid),
          enrolledRoster: updatedRoster
        });
        sub.enrolledRoster = updatedRoster;
        enrollCount++;
        if (enrollCount % 450 === 0) {
          await enrollBatch.commit();
          enrollBatch = db.batch();
        }
      }
    }

    if (enrollCount % 450 !== 0 && enrollCount > 0) {
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
  if (students.length > MAX_IMPORTED_STUDENTS) {
    throw new HttpsError('invalid-argument', `Import is limited to ${MAX_IMPORTED_STUDENTS} students per request.`);
  }
  if (students.some(student => !student || typeof student !== 'object' || Array.isArray(student))) {
    throw new HttpsError('invalid-argument', 'Each student record must be an object.');
  }

  const departmentsMap = await loadDepartmentsMap();
  const subjectsSnap = await db.collection('subjects').get();
  const cachedSubjects = subjectsSnap.docs.map(doc => ({ ref: doc.ref, data: doc.data() }));
  const results = [];
  let importedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const stu of students) {
    const rowResult = await importSingleStudent(stu, departmentsMap, cachedSubjects);
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

exports.submitAttendance = onCall(async request => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in to mark attendance.');
  }

  const data = request.data || {};
  const sessionId = asString(data.sessionId);
  const subjectId = asString(data.subjectId);
  if (!sessionId || !subjectId) {
    throw new HttpsError('invalid-argument', 'sessionId and subjectId are required.');
  }
  const studentUid = request.auth.uid;

  const [sessionSnap, subjectSnap, studentSnap] = await Promise.all([
    db.collection('attendanceSessions').doc(sessionId).get(),
    db.collection('subjects').doc(subjectId).get(),
    db.collection('students').doc(studentUid).get()
  ]);
  if (!sessionSnap.exists || !subjectSnap.exists || !studentSnap.exists) {
    throw new HttpsError('failed-precondition', 'The attendance session or subject no longer exists.');
  }

  const session = sessionSnap.data();
  const subject = subjectSnap.data();
  const student = studentSnap.data();
  const enrolled = Array.isArray(subject.studentIds) && subject.studentIds.includes(studentUid);
  if (session.active !== true || session.subjectId !== subjectId || !enrolled) {
    throw new HttpsError('permission-denied', 'You are not allowed to mark attendance for this session.');
  }

  if (session.expiresAt?.toDate && session.expiresAt.toDate() <= new Date()) {
    throw new HttpsError('failed-precondition', 'This attendance session has expired.');
  }

  const attendanceRef = db.collection('attendance').doc(`${sessionId}_${studentUid}`);
  if ((await attendanceRef.get()).exists) {
    throw new HttpsError('already-exists', 'Attendance has already been marked for this session.');
  }

  const latitude = data.latitude;
  const longitude = data.longitude;
  const hasStudentLocation = typeof latitude === 'number' && Number.isFinite(latitude)
    && typeof longitude === 'number' && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  const hasSessionLocation = typeof session.latitude === 'number' && Number.isFinite(session.latitude)
    && typeof session.longitude === 'number' && Number.isFinite(session.longitude)
    && session.latitude >= -90 && session.latitude <= 90 && session.longitude >= -180 && session.longitude <= 180;
  if (!hasStudentLocation || !hasSessionLocation) {
    throw new HttpsError('failed-precondition', 'A verified student and session location are required.');
  }
  const measuredDistance = distanceMeters(latitude, longitude, session.latitude, session.longitude);
  const geofenceRadius = Number.isFinite(session.geofenceRadius) ? session.geofenceRadius : 50;
  if (measuredDistance > geofenceRadius) {
    throw new HttpsError('permission-denied', 'You are outside the attendance geofence.');
  }

  await attendanceRef.create({
    studentId: studentUid,
    studentUid,
    studentName: asString(student.name) || 'Student',
    studentUsn: asString(student.usn).toUpperCase(),
    usn: asString(student.usn).toUpperCase(),
    studentDept: asString(student.dept || student.department),
    studentSemester: Number.isInteger(student.semester) ? student.semester : 1,
    studentSection: asString(student.section) || 'A',
    subjectId,
    subjectName: asString(session.subjectName) || asString(subject.subjectName) || 'Subject',
    subjectCode: asString(session.subjectCode) || asString(subject.subjectCode),
    sessionId,
    classNumber: session.classNumber || 1,
    facultyId: asString(session.facultyId),
    facultyUid: asString(session.facultyUid),
    facultyName: asString(session.facultyName) || 'Faculty',
    date: asString(session.date),
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    latitude,
    longitude,
    distance: measuredDistance,
    status: 'present',
    attendanceMethod: 'biometric_gps',
    timestamp: FieldValue.serverTimestamp()
  });

  return { success: true, attendanceId: attendanceRef.id };
});

// =========================================================================
// FACE RE-REGISTRATION REQUEST APPROVAL
// =========================================================================
// Used by Faculty and Admin to approve face re-registration requests.
// Enforcement: The caller (faculty or admin) must be authorized. The student
// cannot approve their own request. A server-approved timestamp and approving
// UID are written server-side, which the client checks before allowing the
// controlled re-registration flow.
//
// Rate limiting: Enforces a cooldown on re-registration per student.
// =========================================================================

const FACE_REREG_APPROVAL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const FACE_REREG_MAX_APPROVALS = 3; // max approvals per student ever

async function isAssignedFacultyForSubject(facultyUid, subjectId) {
  if (!facultyUid || !subjectId) return false;
  const subjectDoc = await db.collection('subjects').doc(subjectId).get();
  if (!subjectDoc.exists) return false;
  const sub = subjectDoc.data();
  return sub.facultyUid === facultyUid || sub.facultyId === facultyUid;
}

exports.approveFaceReRegistration = onCall(async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const callerUid = request.auth.uid;
  const requestId = asString(request.data?.requestId);
  const reason = asString(request.data?.reason) || null;

  if (!requestId) {
    throw new HttpsError('invalid-argument', 'Request ID is required.');
  }

  const requestRef = db.collection('faceReRegistrationRequests').doc(requestId);
  const requestDoc = await requestRef.get();

  if (!requestDoc.exists) {
    throw new HttpsError('not-found', 'Face re-registration request not found.');
  }

  const reqData = requestDoc.data();

  if (reqData.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'This request has already been processed.');
  }

  // Determine if caller is an admin
  const callerIsAdmin = await isAdmin(request.auth);

  // Determine if caller is faculty for ANY of the student's enrolled subjects
  // (Uses authoritative Firestore enrollment data, not client-supplied fields)
  const targetStudentUid = reqData.studentUid;
  let isAssignedFaculty = false;
  try {
    const studentSubjectsSnap = await db.collection('subjects')
      .where('studentIds', 'array-contains', targetStudentUid)
      .get();
    for (const subDoc of studentSubjectsSnap.docs) {
      if (await isAssignedFacultyForSubject(callerUid, subDoc.id)) {
        isAssignedFaculty = true;
        break;
      }
    }
  } catch (err) {
    console.error('[approveFaceReRegistration] Subject authorization check error:', err);
  }

  if (!callerIsAdmin && !isAssignedFaculty) {
    throw new HttpsError('permission-denied', 'Only an assigned faculty member or admin may approve this request.');
  }

  // Prevent self-approval: ensure the student is not approving their own request
  if (reqData.studentUid === callerUid) {
    throw new HttpsError('permission-denied', 'Students cannot approve their own face re-registration request.');
  }

  // Rate limiting: check existing approvals and cooldown
  const auditSnap = await db.collection('faceReRegistrationRequests')
    .where('studentUid', '==', targetStudentUid)
    .where('status', '==', 'approved')
    .limit(FACE_REREG_MAX_APPROVALS + 1)
    .get();

  if (auditSnap.size >= FACE_REREG_MAX_APPROVALS) {
    throw new HttpsError('failed-precondition', `Maximum of ${FACE_REREG_MAX_APPROVALS} approvals reached for this student.`);
  }

  const now = Date.now();
  for (const doc of auditSnap.docs) {
    const approvedAt = doc.data().serverApprovedAt;
    if (approvedAt && (now - approvedAt.toMillis()) < FACE_REREG_APPROVAL_COOLDOWN_MS) {
      throw new HttpsError('failed-precondition', 'Approval cooldown active. Wait before requesting another face re-registration.');
    }
  }

  // Fetch student to verify they exist and record audit
  const studentDoc = await db.collection('students').doc(targetStudentUid).get();
  if (!studentDoc.exists) {
    throw new HttpsError('not-found', 'Student profile not found.');
  }

  await requestRef.update({
    status: 'approved',
    approvedBy: callerUid,
    serverApprovedAt: FieldValue.serverTimestamp(),
    reviewReason: reason,
    reviewedAt: FieldValue.serverTimestamp()
  });

  return {
    success: true,
    requestId,
    studentUid: targetStudentUid,
    approvedBy: callerUid,
    method: 'approved_recovery'
  };
});
