// scratch/test_security_suite.js
// Complete Test Suite for CIT Smart Attendance Security Upgrade
// Validates Tests 1 through 11 according to Prompt Requirements

function computeEuclidean(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeEyeAspectRatio(landmarks) {
  const pts = landmarks.positions;
  const rV1 = computeEuclidean(pts[37], pts[41]);
  const rV2 = computeEuclidean(pts[38], pts[40]);
  const rH = computeEuclidean(pts[36], pts[39]);
  const rightEar = rH > 0 ? (rV1 + rV2) / (2.0 * rH) : 0.3;

  const lV1 = computeEuclidean(pts[43], pts[47]);
  const lV2 = computeEuclidean(pts[44], pts[46]);
  const lH = computeEuclidean(pts[42], pts[45]);
  const leftEar = lH > 0 ? (lV1 + lV2) / (2.0 * lH) : 0.3;

  return (rightEar + leftEar) / 2.0;
}

function computeFacialYaw(landmarks) {
  const pts = landmarks.positions;
  const noseTip = pts[30];
  const rightJaw = pts[0];
  const leftJaw = pts[16];

  const distRight = Math.abs(noseTip.x - rightJaw.x);
  const distLeft = Math.abs(leftJaw.x - noseTip.x);
  const totalWidth = Math.abs(leftJaw.x - rightJaw.x);

  if (totalWidth < 1) return 0;
  return (distRight - distLeft) / totalWidth;
}

function computeSmileRatio(landmarks) {
  const pts = landmarks.positions;
  const mouthWidth = computeEuclidean(pts[48], pts[54]);
  const eyeDistance = computeEuclidean(pts[36], pts[45]);
  if (eyeDistance < 1) return 1.0;
  return mouthWidth / eyeDistance;
}

function createLandmarks({ yaw = 0, ear = 0.30, smileRatio = 0.88 }) {
  const positions = new Array(68).fill(null).map(() => ({ x: 0, y: 0 }));
  positions[0] = { x: 100, y: 300 };
  positions[16] = { x: 500, y: 300 };
  const totalWidth = 400;
  const distRight = (totalWidth * (1 + yaw)) / 2;
  positions[30] = { x: 100 + distRight, y: 250 };

  const eyeDist = 200;
  positions[36] = { x: 200, y: 200 };
  positions[39] = { x: 250, y: 200 };
  positions[42] = { x: 350, y: 200 };
  positions[45] = { x: 400, y: 200 };

  const eyeHalfH = (ear * 50) / 2;
  positions[37] = { x: 215, y: 200 - eyeHalfH };
  positions[38] = { x: 235, y: 200 - eyeHalfH };
  positions[40] = { x: 235, y: 200 + eyeHalfH };
  positions[41] = { x: 215, y: 200 + eyeHalfH };
  positions[43] = { x: 365, y: 200 - eyeHalfH };
  positions[44] = { x: 385, y: 200 - eyeHalfH };
  positions[46] = { x: 385, y: 200 + eyeHalfH };
  positions[47] = { x: 365, y: 200 + eyeHalfH };

  const mouthW = eyeDist * smileRatio;
  const mouthCenter = positions[30].x;
  positions[48] = { x: mouthCenter - mouthW / 2, y: 350 };
  positions[54] = { x: mouthCenter + mouthW / 2, y: 350 };

  return { positions };
}

function evaluateChallenge(challengeId, landmarks, session) {
  const yaw = computeFacialYaw(landmarks);
  const ear = computeEyeAspectRatio(landmarks);
  const smile = computeSmileRatio(landmarks);

  switch (challengeId) {
    case 'TURN_LEFT': {
      if (!session.stepState || session.stepState === 'INIT' || session.stepState === 'WAIT_NEUTRAL') {
        if (Math.abs(yaw) <= 0.14) {
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_TURN';
            session.stepFrames = 0;
          }
        } else {
          session.stepFrames = 0;
        }
      } else if (session.stepState === 'WAIT_TURN') {
        if (yaw >= 0.18) {
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_RETURN';
            session.stepFrames = 0;
          }
        }
      } else if (session.stepState === 'WAIT_RETURN') {
        if (Math.abs(yaw) <= 0.14) return true;
      }
      break;
    }

    case 'TURN_RIGHT': {
      if (!session.stepState || session.stepState === 'INIT' || session.stepState === 'WAIT_NEUTRAL') {
        if (Math.abs(yaw) <= 0.14) {
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_TURN';
            session.stepFrames = 0;
          }
        } else {
          session.stepFrames = 0;
        }
      } else if (session.stepState === 'WAIT_TURN') {
        if (yaw <= -0.18) {
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_RETURN';
            session.stepFrames = 0;
          }
        }
      } else if (session.stepState === 'WAIT_RETURN') {
        if (Math.abs(yaw) <= 0.14) return true;
      }
      break;
    }

    case 'BLINK_TWICE': {
      const baseEar = session.openEarBaseline || 0.26;
      const OPEN_THRESH = Math.max(0.20, baseEar * 0.80);
      const CLOSE_THRESH = Math.min(0.18, baseEar * 0.65);
      if (!session.stepState || session.stepState === 'INIT' || session.stepState === 'WAIT_OPEN_1') {
        if (ear >= OPEN_THRESH) {
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_CLOSE_1';
            session.stepFrames = 0;
          }
        }
      } else if (session.stepState === 'WAIT_CLOSE_1') {
        if (ear <= CLOSE_THRESH) {
          session.stepState = 'WAIT_REOPEN_1';
          session.stepFrames = 0;
        }
      } else if (session.stepState === 'WAIT_REOPEN_1') {
        if (ear >= OPEN_THRESH) {
          session.stepState = 'WAIT_CLOSE_2';
          session.stepFrames = 0;
        }
      } else if (session.stepState === 'WAIT_CLOSE_2') {
        if (ear <= CLOSE_THRESH) {
          session.stepState = 'WAIT_REOPEN_2';
          session.stepFrames = 0;
        }
      } else if (session.stepState === 'WAIT_REOPEN_2') {
        if (ear >= OPEN_THRESH) return true;
      }
      break;
    }

    case 'SMILE': {
      if (!session.stepState || session.stepState === 'INIT' || session.stepState === 'WAIT_NEUTRAL') {
        if (Math.abs(yaw) <= 0.16) {
          session.baselineMetric = session.baselineMetric ? (session.baselineMetric * 0.7 + smile * 0.3) : smile;
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_SMILE';
            session.stepFrames = 0;
          }
        }
      } else if (session.stepState === 'WAIT_SMILE') {
        const baseSmile = session.baselineMetric || 0.88;
        const target = Math.max(baseSmile * 1.08, baseSmile + 0.05);
        if (smile >= target) {
          session.stepFrames = (session.stepFrames || 0) + 1;
          if (session.stepFrames >= 2) {
            session.stepState = 'WAIT_RELAX';
            session.stepFrames = 0;
          }
        }
      } else if (session.stepState === 'WAIT_RELAX') {
        const baseSmile = session.baselineMetric || 0.88;
        if (smile <= baseSmile * 1.04) return true;
      }
      break;
    }
  }

  return false;
}

// Complete Full Pipeline Simulator
function runVerificationSession({
  sequence = ['TURN_LEFT', 'BLINK_TWICE', 'SMILE'],
  faceDistance = 0.25, // <= 0.6 is match
  framesGenerator,     // generator producing { detectionsCount, landmarks }
  gpsDistance = 5,     // meters, <= 10 is inside geofence
  gpsAccuracy = 15,    // meters, <= 50 is valid
  alreadyMarked = false
}) {
  const session = {
    sequence,
    currentIndex: 0,
    stepState: 'INIT',
    stepFrames: 0,
    baselineMetric: null,
    completedChallenges: [],
    faceMatched: false,
    livenessPassed: false,
    faceVerified: false,
    timedOut: false,
    failureReason: null
  };

  const frames = framesGenerator(sequence);

  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    const frame = frames[frameIdx];

    // Face count validation
    if (frame.detectionsCount === 0) {
      continue;
    }
    if (frame.detectionsCount > 1) {
      // Multiple faces detected
      session.failureReason = 'Multiple faces detected';
      continue;
    }

    // Exactly 1 face
    // Face descriptor match check
    if (faceDistance <= 0.6) {
      session.faceMatched = true;
    } else {
      session.failureReason = 'Face does not match registered student';
      return { session, attendanceCreated: false, reason: session.failureReason };
    }

    // Liveness challenge step evaluation
    const currentChallengeId = session.sequence[session.currentIndex];
    const passed = evaluateChallenge(currentChallengeId, frame.landmarks, session);

    if (passed) {
      session.completedChallenges.push(currentChallengeId);
      session.currentIndex++;
      session.stepState = 'INIT';
      session.stepFrames = 0;
      session.baselineMetric = null;

      if (session.currentIndex >= session.sequence.length) {
        if (session.faceMatched) {
          session.livenessPassed = true;
          session.faceVerified = true;
          break;
        }
      }
    }
  }

  // Final attendance submission check:
  // Requires: faceMatched && livenessPassed && faceVerified && GPS valid && not already marked
  if (!session.faceMatched || !session.livenessPassed || !session.faceVerified) {
    return { session, attendanceCreated: false, reason: session.failureReason || 'Liveness incomplete' };
  }

  // GPS verification
  if (gpsAccuracy > 50) {
    return { session, attendanceCreated: false, reason: 'GPS accuracy too low' };
  }
  if (gpsDistance > 10) {
    return { session, attendanceCreated: false, reason: 'GPS out of geofence' };
  }

  // Duplicate attendance check
  if (alreadyMarked) {
    return { session, attendanceCreated: false, reason: 'Attendance already marked' };
  }

  return { session, attendanceCreated: true, reason: 'SUCCESS' };
}

// Helpers to produce realistic human motion frames
function makeTurnLeftFrames() {
  const f = [];
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ yaw: 0 }) });
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ yaw: 0.35 }) });
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ yaw: 0.05 }) });
  return f;
}

function makeBlinkTwiceFrames() {
  const f = [];
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ ear: 0.30 }) });
  f.push({ detectionsCount: 1, landmarks: createLandmarks({ ear: 0.12 }) });
  for (let i = 0; i < 2; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ ear: 0.30 }) });
  f.push({ detectionsCount: 1, landmarks: createLandmarks({ ear: 0.12 }) });
  for (let i = 0; i < 2; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ ear: 0.30 }) });
  return f;
}

function makeSmileFrames() {
  const f = [];
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ smileRatio: 0.88 }) });
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ smileRatio: 1.10 }) });
  for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ smileRatio: 0.90 }) });
  return f;
}

// =========================================================================
// RUN ALL 11 REQUIRED SECURITY TESTS
// =========================================================================
console.log('====================================================');
console.log('RUNNING CIT SMART ATTENDANCE SECURITY TEST SUITE (11/11)');
console.log('====================================================\n');

let passed = 0;
let total = 0;

function runTest(testNum, name, testFn) {
  total++;
  const result = testFn();
  if (result.ok) {
    passed++;
    console.log(`[PASS] TEST ${testNum}: ${name}`);
    if (result.info) console.log(`       └─ Result: ${result.info}`);
  } else {
    console.error(`[FAIL] TEST ${testNum}: ${name}`);
    console.error(`       └─ Details: ${result.info}`);
  }
}

// TEST 1: Real person + correct face -> PASS
runTest(1, 'Real person + correct face', () => {
  const res = runVerificationSession({
    faceDistance: 0.22,
    framesGenerator: () => [...makeTurnLeftFrames(), ...makeBlinkTwiceFrames(), ...makeSmileFrames()]
  });
  return { ok: res.attendanceCreated === true, info: `Attendance Created (Face: Verified, Liveness: Verified)` };
});

// TEST 2: Wrong person's face -> FAIL
runTest(2, "Wrong person's face", () => {
  const res = runVerificationSession({
    faceDistance: 0.85, // Mismatch > 0.6
    framesGenerator: () => [...makeTurnLeftFrames(), ...makeBlinkTwiceFrames(), ...makeSmileFrames()]
  });
  return { ok: res.attendanceCreated === false && res.session.faceVerified === false, info: `Blocked: ${res.reason}` };
});

// TEST 3: Static photo of correct student -> FAIL
runTest(3, 'Static photo of correct student', () => {
  const res = runVerificationSession({
    faceDistance: 0.15, // matches photo
    framesGenerator: () => {
      // 50 identical static frames
      return new Array(50).fill(null).map(() => ({
        detectionsCount: 1,
        landmarks: createLandmarks({ yaw: 0.02, ear: 0.28, smileRatio: 0.88 })
      }));
    }
  });
  return { ok: res.attendanceCreated === false && res.session.livenessPassed === false, info: `Blocked: ${res.reason}` };
});

// TEST 4: Photo displayed on phone -> FAIL
runTest(4, 'Photo displayed on phone', () => {
  const res = runVerificationSession({
    faceDistance: 0.18,
    framesGenerator: () => {
      return new Array(50).fill(null).map(() => ({
        detectionsCount: 1,
        landmarks: createLandmarks({ yaw: -0.01, ear: 0.30, smileRatio: 0.89 })
      }));
    }
  });
  return { ok: res.attendanceCreated === false && res.session.livenessPassed === false, info: `Blocked: ${res.reason}` };
});

// TEST 5: Photo displayed on laptop -> FAIL
runTest(5, 'Photo displayed on laptop', () => {
  const res = runVerificationSession({
    faceDistance: 0.20,
    framesGenerator: () => {
      return new Array(50).fill(null).map(() => ({
        detectionsCount: 1,
        landmarks: createLandmarks({ yaw: 0.03, ear: 0.29, smileRatio: 0.90 })
      }));
    }
  });
  return { ok: res.attendanceCreated === false && res.session.livenessPassed === false, info: `Blocked: ${res.reason}` };
});

// TEST 6: Multiple faces -> FAIL
runTest(6, 'Multiple faces', () => {
  const res = runVerificationSession({
    faceDistance: 0.25,
    framesGenerator: () => {
      return new Array(30).fill(null).map(() => ({
        detectionsCount: 2, // 2 faces
        landmarks: createLandmarks({})
      }));
    }
  });
  return { ok: res.attendanceCreated === false && res.session.livenessPassed === false, info: `Blocked: ${res.reason}` };
});

// TEST 7: Real person but does not perform challenge -> FAIL
runTest(7, 'Real person but does not perform challenge (Idle/Stare)', () => {
  const res = runVerificationSession({
    faceDistance: 0.20,
    framesGenerator: () => {
      // User just stares blankly at camera
      return new Array(40).fill(null).map(() => ({
        detectionsCount: 1,
        landmarks: createLandmarks({ yaw: 0, ear: 0.30, smileRatio: 0.88 })
      }));
    }
  });
  return { ok: res.attendanceCreated === false && res.session.livenessPassed === false, info: `Blocked: ${res.reason}` };
});

// TEST 8: Real person performs wrong challenge -> FAIL
runTest(8, 'Real person performs wrong challenge (Turns Right when Left asked)', () => {
  const res = runVerificationSession({
    sequence: ['TURN_LEFT'],
    faceDistance: 0.20,
    framesGenerator: () => {
      // User turns right instead of left
      return new Array(20).fill(null).map(() => ({
        detectionsCount: 1,
        landmarks: createLandmarks({ yaw: -0.35 })
      }));
    }
  });
  return { ok: res.attendanceCreated === false && res.session.livenessPassed === false, info: `Blocked: ${res.reason}` };
});

// TEST 9: Real person performs correct randomized challenges -> PASS
runTest(9, 'Real person performs correct randomized challenges (Smile -> Turn Right -> Blink)', () => {
  function makeTurnRightFrames() {
    const f = [];
    for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ yaw: 0 }) });
    for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ yaw: -0.35 }) });
    for (let i = 0; i < 3; i++) f.push({ detectionsCount: 1, landmarks: createLandmarks({ yaw: -0.05 }) });
    return f;
  }
  const randomizedSequence = ['SMILE', 'TURN_RIGHT', 'BLINK_TWICE'];
  const res = runVerificationSession({
    sequence: randomizedSequence,
    faceDistance: 0.21,
    framesGenerator: () => [...makeSmileFrames(), ...makeTurnRightFrames(), ...makeBlinkTwiceFrames()]
  });
  return { ok: res.attendanceCreated === true, info: `Completed all ${res.session.completedChallenges.join(' -> ')}` };
});

// TEST 10: After liveness success, GPS fails -> attendance NOT created
runTest(10, 'After liveness success, GPS fails (Out of Geofence: 45m > 10m)', () => {
  const res = runVerificationSession({
    faceDistance: 0.22,
    framesGenerator: () => [...makeTurnLeftFrames(), ...makeBlinkTwiceFrames(), ...makeSmileFrames()],
    gpsDistance: 45 // outside 10m geofence!
  });
  return { ok: res.attendanceCreated === false && res.reason === 'GPS out of geofence', info: `Blocked: ${res.reason}` };
});

// TEST 11: After liveness + GPS success, duplicate attendance attempt -> attendance NOT duplicated
runTest(11, 'After liveness + GPS success, duplicate attendance attempt -> Blocked', () => {
  const res = runVerificationSession({
    faceDistance: 0.22,
    framesGenerator: () => [...makeTurnLeftFrames(), ...makeBlinkTwiceFrames(), ...makeSmileFrames()],
    alreadyMarked: true // student already recorded for this session
  });
  return { ok: res.attendanceCreated === false && res.reason === 'Attendance already marked', info: `Blocked: ${res.reason}` };
});

console.log('\n====================================================');
console.log(`FINAL SECURITY SUITE SCORE: ${passed}/${total} TESTS PASSED`);
console.log('====================================================');
