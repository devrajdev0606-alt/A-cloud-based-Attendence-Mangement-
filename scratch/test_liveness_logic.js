// scratch/test_liveness_logic.js
// Verification script for Active Liveness State Machine and Geometric Calculations

function computeEuclidean(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeEyeDetails(landmarks) {
  const pts = landmarks.positions || landmarks;
  if (!pts || pts.length < 48) {
    return { leftEar: 0.3, rightEar: 0.3, avgEar: 0.3, valid: false };
  }
  // Right eye: 36..41 (anatomical right / viewer left)
  const rV1 = computeEuclidean(pts[37], pts[41]);
  const rV2 = computeEuclidean(pts[38], pts[40]);
  const rH = computeEuclidean(pts[36], pts[39]);
  const rightEar = rH > 0 ? (rV1 + rV2) / (2.0 * rH) : 0.3;

  // Left eye: 42..47 (anatomical left / viewer right)
  const lV1 = computeEuclidean(pts[43], pts[47]);
  const lV2 = computeEuclidean(pts[44], pts[46]);
  const lH = computeEuclidean(pts[42], pts[45]);
  const leftEar = lH > 0 ? (lV1 + lV2) / (2.0 * lH) : 0.3;

  const avgEar = (rightEar + leftEar) / 2.0;
  return { leftEar, rightEar, avgEar, valid: true };
}

function computeEyeAspectRatio(landmarks) {
  return computeEyeDetails(landmarks).avgEar;
}

function computeFacialYaw(landmarks) {
  const pts = landmarks.positions;
  const noseTip = pts[30];
  const rightJaw = pts[0];  // anatomical right (viewer's left in unmirrored canvas)
  const leftJaw = pts[16];  // anatomical left (viewer's right in unmirrored canvas)

  const distRight = Math.abs(noseTip.x - rightJaw.x);
  const distLeft = Math.abs(leftJaw.x - noseTip.x);
  const totalWidth = Math.abs(leftJaw.x - rightJaw.x);

  if (totalWidth < 1) return 0;
  // yaw > 0 => turned towards user's left; yaw < 0 => turned towards user's right
  return (distRight - distLeft) / totalWidth;
}

function computeSmileRatio(landmarks) {
  const pts = landmarks.positions;
  const mouthWidth = computeEuclidean(pts[48], pts[54]);
  const eyeDistance = computeEuclidean(pts[36], pts[45]);
  if (eyeDistance < 1) return 1.0;
  return mouthWidth / eyeDistance;
}

// Generate synthetic 68-landmark template
function createSyntheticLandmarks(options = {}) {
  const {
    yaw = 0,             // -0.5 to +0.5
    ear = 0.30,          // 0.12 (closed) to 0.32 (open)
    smileRatio = 0.88    // 0.85 (neutral) to 1.15 (smiling)
  } = options;

  const positions = new Array(68).fill(null).map(() => ({ x: 0, y: 0 }));

  // Jaw width 400px (x=100 to x=500, center=300)
  positions[0] = { x: 100, y: 300 };
  positions[16] = { x: 500, y: 300 };

  // Nose tip (point 30) - centered at 300 when yaw=0
  // yaw = (distRight - distLeft) / totalWidth
  // distRight = (totalWidth * (1 + yaw)) / 2
  // noseX = 100 + distRight
  const totalWidth = 400;
  const distRight = (totalWidth * (1 + yaw)) / 2;
  positions[30] = { x: 100 + distRight, y: 250 };

  // Eyes (outer corners 36 and 45, width = 200px from 200 to 400)
  const eyeDist = 200;
  positions[36] = { x: 200, y: 200 };
  positions[39] = { x: 250, y: 200 };
  positions[42] = { x: 350, y: 200 };
  positions[45] = { x: 400, y: 200 };

  // Eye height determined by ear (rH = 50, ear = (v1+v2)/(2*50) => v = ear * 50)
  const eyeHalfH = (ear * 50) / 2;
  // Right eye top/bottom
  positions[37] = { x: 215, y: 200 - eyeHalfH };
  positions[38] = { x: 235, y: 200 - eyeHalfH };
  positions[40] = { x: 235, y: 200 + eyeHalfH };
  positions[41] = { x: 215, y: 200 + eyeHalfH };
  // Left eye top/bottom
  positions[43] = { x: 365, y: 200 - eyeHalfH };
  positions[44] = { x: 385, y: 200 - eyeHalfH };
  positions[46] = { x: 385, y: 200 + eyeHalfH };
  positions[47] = { x: 365, y: 200 + eyeHalfH };

  // Mouth: outer corners 48 and 54
  // mouthWidth = eyeDist * smileRatio
  const mouthW = eyeDist * smileRatio;
  const mouthCenter = positions[30].x; // follows nose
  positions[48] = { x: mouthCenter - mouthW / 2, y: 350 };
  positions[54] = { x: mouthCenter + mouthW / 2, y: 350 };

  return { positions };
}

// Challenge State Machine Simulator
class LivenessEvaluator {
  constructor(challengeType, openEarBaseline = 0.28) {
    this.challengeType = challengeType;
    this.state = 'WAIT_NEUTRAL';
    this.stateFrames = 0;
    this.baseline = null;
    this.openEarBaseline = openEarBaseline;
    this.passed = false;
  }

  feedFrame(landmarks) {
    if (this.passed) return true;
    const yaw = computeFacialYaw(landmarks);
    const ear = computeEyeAspectRatio(landmarks);
    const smile = computeSmileRatio(landmarks);

    switch (this.challengeType) {
      case 'TURN_LEFT': {
        if (this.state === 'WAIT_NEUTRAL') {
          if (Math.abs(yaw) <= 0.14) {
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_TURN';
              this.stateFrames = 0;
            }
          } else {
            this.stateFrames = 0;
          }
        } else if (this.state === 'WAIT_TURN') {
          if (yaw >= 0.18) {
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_RETURN';
              this.stateFrames = 0;
            }
          }
        } else if (this.state === 'WAIT_RETURN') {
          if (Math.abs(yaw) <= 0.14) {
            this.passed = true;
          }
        }
        break;
      }

      case 'TURN_RIGHT': {
        if (this.state === 'WAIT_NEUTRAL') {
          if (Math.abs(yaw) <= 0.14) {
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_TURN';
              this.stateFrames = 0;
            }
          } else {
            this.stateFrames = 0;
          }
        } else if (this.state === 'WAIT_TURN') {
          if (yaw <= -0.18) {
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_RETURN';
              this.stateFrames = 0;
            }
          }
        } else if (this.state === 'WAIT_RETURN') {
          if (Math.abs(yaw) <= 0.14) {
            this.passed = true;
          }
        }
        break;
      }

      case 'BLINK_TWICE': {
        const baseEar = this.openEarBaseline || 0.26;
        const OPEN_THRESH = Math.max(0.20, baseEar * 0.80);
        const CLOSE_THRESH = Math.min(0.18, baseEar * 0.65);
        if (this.state === 'WAIT_NEUTRAL' || this.state === 'WAIT_OPEN_1') {
          if (ear >= OPEN_THRESH) {
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_CLOSE_1';
              this.stateFrames = 0;
            }
          }
        } else if (this.state === 'WAIT_CLOSE_1') {
          if (ear <= CLOSE_THRESH) {
            this.state = 'WAIT_REOPEN_1';
            this.stateFrames = 0;
          }
        } else if (this.state === 'WAIT_REOPEN_1') {
          if (ear >= OPEN_THRESH) {
            this.state = 'WAIT_CLOSE_2';
            this.stateFrames = 0;
          }
        } else if (this.state === 'WAIT_CLOSE_2') {
          if (ear <= CLOSE_THRESH) {
            this.state = 'WAIT_REOPEN_2';
            this.stateFrames = 0;
          }
        } else if (this.state === 'WAIT_REOPEN_2') {
          if (ear >= OPEN_THRESH) {
            this.passed = true;
          }
        }
        break;
      }

      case 'SMILE': {
        if (this.state === 'WAIT_NEUTRAL') {
          if (Math.abs(yaw) <= 0.16) {
            this.baseline = this.baseline ? (this.baseline * 0.7 + smile * 0.3) : smile;
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_SMILE';
              this.stateFrames = 0;
            }
          }
        } else if (this.state === 'WAIT_SMILE') {
          const baseSmile = this.baseline || 0.88;
          const target = Math.max(baseSmile * 1.08, baseSmile + 0.05);
          if (smile >= target) {
            this.stateFrames++;
            if (this.stateFrames >= 2) {
              this.state = 'WAIT_RELAX';
              this.stateFrames = 0;
            }
          }
        } else if (this.state === 'WAIT_RELAX') {
          const baseSmile = this.baseline || 0.88;
          if (smile <= baseSmile * 1.04) {
            this.passed = true;
          }
        }
        break;
      }
    }

    return this.passed;
  }
}

// ==========================================
// TEST SUITE EXECUTION
// ==========================================
console.log('--- STARTING LIVENESS EVALUATION TESTS ---');

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`[PASS] ${testName}`);
  } else {
    console.error(`[FAIL] ${testName}`);
  }
}

// TEST 1: Real Person Turn Left
{
  const evalLeft = new LivenessEvaluator('TURN_LEFT');
  // 3 neutral frames
  for (let i = 0; i < 3; i++) evalLeft.feedFrame(createSyntheticLandmarks({ yaw: 0 }));
  // 3 turned left frames
  for (let i = 0; i < 3; i++) evalLeft.feedFrame(createSyntheticLandmarks({ yaw: 0.35 }));
  // 2 return to neutral frames
  for (let i = 0; i < 2; i++) evalLeft.feedFrame(createSyntheticLandmarks({ yaw: 0.05 }));
  assert(evalLeft.passed === true, 'TEST 1: Real Person Turn Left (Neutral -> Left -> Return) -> PASS');
}

// TEST 2: Real Person Turn Right
{
  const evalRight = new LivenessEvaluator('TURN_RIGHT');
  for (let i = 0; i < 3; i++) evalRight.feedFrame(createSyntheticLandmarks({ yaw: 0 }));
  for (let i = 0; i < 3; i++) evalRight.feedFrame(createSyntheticLandmarks({ yaw: -0.35 }));
  for (let i = 0; i < 2; i++) evalRight.feedFrame(createSyntheticLandmarks({ yaw: -0.05 }));
  assert(evalRight.passed === true, 'TEST 2: Real Person Turn Right (Neutral -> Right -> Return) -> PASS');
}

// TEST 3: Real Person Blink Twice
{
  const evalBlink = new LivenessEvaluator('BLINK_TWICE');
  // Neutral open
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  // Blink 1: close then open
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.12 }));
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  // Blink 2: close then open
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.12 }));
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  assert(evalBlink.passed === true, 'TEST 3: Real Person Blink Twice (Open -> Close -> Open -> Close -> Open) -> PASS');
}

// TEST 4: Real Person Smile
{
  const evalSmile = new LivenessEvaluator('SMILE');
  // Neutral baseline (smileRatio ~ 0.88)
  evalSmile.feedFrame(createSyntheticLandmarks({ smileRatio: 0.88 }));
  evalSmile.feedFrame(createSyntheticLandmarks({ smileRatio: 0.88 }));
  // Smiles (smileRatio ~ 1.08)
  evalSmile.feedFrame(createSyntheticLandmarks({ smileRatio: 1.08 }));
  evalSmile.feedFrame(createSyntheticLandmarks({ smileRatio: 1.08 }));
  // Relaxes back (smileRatio ~ 0.90)
  evalSmile.feedFrame(createSyntheticLandmarks({ smileRatio: 0.90 }));
  assert(evalSmile.passed === true, 'TEST 4: Real Person Smile (Neutral -> Smile -> Relax) -> PASS');
}

// TEST 5: Static Photo Attack (Eyes Open, Neutral, 50 frames)
{
  const evalLeft = new LivenessEvaluator('TURN_LEFT');
  const evalBlink = new LivenessEvaluator('BLINK_TWICE');
  const evalSmile = new LivenessEvaluator('SMILE');
  for (let i = 0; i < 50; i++) {
    const staticFrame = createSyntheticLandmarks({ yaw: 0.02, ear: 0.29, smileRatio: 0.88 });
    evalLeft.feedFrame(staticFrame);
    evalBlink.feedFrame(staticFrame);
    evalSmile.feedFrame(staticFrame);
  }
  assert(evalLeft.passed === false && evalBlink.passed === false && evalSmile.passed === false,
    'TEST 5: Static Photo Attack (Constant Frame Across 50 Frames) -> ALL FAIL');
}

// TEST 6: Static Photo Attack with Closed Eyes
{
  const evalBlink = new LivenessEvaluator('BLINK_TWICE');
  for (let i = 0; i < 50; i++) {
    const staticClosed = createSyntheticLandmarks({ yaw: 0, ear: 0.12, smileRatio: 0.88 });
    evalBlink.feedFrame(staticClosed);
  }
  assert(evalBlink.passed === false, 'TEST 6: Static Photo Attack with Eyes Closed -> FAIL');
}

// TEST 7: Static Photo Attack with Static Smile
{
  const evalSmile = new LivenessEvaluator('SMILE');
  for (let i = 0; i < 50; i++) {
    const staticSmile = createSyntheticLandmarks({ yaw: 0, ear: 0.30, smileRatio: 1.10 });
    evalSmile.feedFrame(staticSmile);
  }
  assert(evalSmile.passed === false, 'TEST 7: Static Photo Attack with Static Smile -> FAIL');
}

// TEST 8: Wrong Challenge Performed (User turns Right when Challenge is Turn Left)
{
  const evalLeft = new LivenessEvaluator('TURN_LEFT');
  evalLeft.feedFrame(createSyntheticLandmarks({ yaw: 0 }));
  evalLeft.feedFrame(createSyntheticLandmarks({ yaw: 0 }));
  // Turn right instead of left
  for (let i = 0; i < 10; i++) {
    evalLeft.feedFrame(createSyntheticLandmarks({ yaw: -0.35 }));
  }
  assert(evalLeft.passed === false, 'TEST 8: Wrong Challenge Performed (Turn Right during Turn Left challenge) -> FAIL');
}

// TEST 9: Incomplete Blink (Only 1 blink instead of 2)
{
  const evalBlink = new LivenessEvaluator('BLINK_TWICE');
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.12 }));
  evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  // Stays open, never does 2nd blink
  for (let i = 0; i < 15; i++) evalBlink.feedFrame(createSyntheticLandmarks({ ear: 0.30 }));
  assert(evalBlink.passed === false, 'TEST 9: Incomplete Blink (1 blink only) -> FAIL');
}

// TEST 10: Face Identity Matching Logic
{
  function mockEuclidean(d1, d2) {
    let sum = 0;
    for (let i = 0; i < d1.length; i++) sum += (d1[i] - d2[i]) ** 2;
    return Math.sqrt(sum);
  }
  const regFace = new Array(128).fill(0.1);
  const matchingLiveFace = new Array(128).fill(0.11); // dist ~ 0.113 < 0.6
  const imposterLiveFace = new Array(128).fill(0.25); // dist ~ 1.69 > 0.6
  const distMatch = mockEuclidean(regFace, matchingLiveFace);
  const distImposter = mockEuclidean(regFace, imposterLiveFace);

  assert(distMatch <= 0.6, 'TEST 10a: Registered Student Face Descriptor Match <= 0.6 -> PASS');
  assert(distImposter > 0.6, 'TEST 10b: Imposter Face Descriptor Match > 0.6 -> FAIL');
}

// TEST 11: Stable Face Requirement (Must detect face 3 times before starting liveness)
{
  let stableFaceCount = 0;
  let state = 'FACE_SEARCHING';

  function processDetection(detected) {
    if (detected) {
      stableFaceCount++;
      if (stableFaceCount >= 3) {
        state = 'LIVENESS_RUNNING';
      }
    } else {
      stableFaceCount = 0;
    }
  }

  // 2 detections -> still searching
  processDetection(true);
  processDetection(true);
  assert(state === 'FACE_SEARCHING' && stableFaceCount === 2, 'TEST 11a: 2 Face frames not enough -> Still Searching');

  // Dropped frame resets counter
  processDetection(false);
  assert(stableFaceCount === 0, 'TEST 11b: Dropped frame resets stable counter');

  // 3 consecutive detections -> Transitions to LIVENESS_RUNNING
  processDetection(true);
  processDetection(true);
  processDetection(true);
  assert(state === 'LIVENESS_RUNNING', 'TEST 11c: 3 consecutive detections -> Starts Liveness');
}

// TEST 12: Per-Challenge Timeout Reset Logic
{
  const CHALLENGE_TIMEOUT_MS = 12000;
  let now = 100000;
  let deadline = now + CHALLENGE_TIMEOUT_MS;

  // 8 seconds pass in challenge 1
  now += 8000;
  let remainingMs = Math.max(0, deadline - now);
  assert(remainingMs === 4000, 'TEST 12a: 4 seconds remaining in challenge 1');

  // Challenge 1 completes -> Reset deadline for challenge 2
  deadline = now + CHALLENGE_TIMEOUT_MS;
  remainingMs = Math.max(0, deadline - now);
  assert(remainingMs === 12000, 'TEST 12b: Challenge 2 starts with fresh 12s deadline');
}

// TEST 13: Retry / Session Token Invalidation
{
  let currentSessionToken = 1;

  function runFrame(token) {
    if (token !== currentSessionToken) {
      return 'ABORTED';
    }
    return 'PROCESSED';
  }

  // Session 1 processes frame
  assert(runFrame(1) === 'PROCESSED', 'TEST 13a: Session 1 runs normally');

  // Retry clicked -> token increments
  currentSessionToken++;

  // Stale session 1 callback arrives -> rejected
  assert(runFrame(1) === 'ABORTED', 'TEST 13b: Stale session 1 callback is aborted on retry');
  // New session 2 runs
  assert(runFrame(2) === 'PROCESSED', 'TEST 13c: New session 2 runs cleanly');
}

// TEST 14: Multiple Faces Blocking
{
  let multipleFacesFrames = 0;
  let verificationBlocked = false;

  function handleDetections(count) {
    if (count > 1) {
      multipleFacesFrames++;
      if (multipleFacesFrames >= 8) {
        verificationBlocked = true;
      }
    } else {
      multipleFacesFrames = 0;
    }
  }

  for (let i = 0; i < 7; i++) handleDetections(2);
  assert(verificationBlocked === false, 'TEST 14a: Multiple faces warning triggered before block');

  handleDetections(2); // 8th frame
  assert(verificationBlocked === true, 'TEST 14b: Multiple faces blocks verification');
}

console.log(`\nRESULTS: ${passedTests}/${totalTests} tests passed!`);

