// Targeted regression tests for calibrated head-turn geometry and temporal states.

const CONFIG = {
  baselineFrames: 6,
  smoothingWindow: 5,
  turnThreshold: 0.14,
  returnThreshold: 0.08,
  requiredTurnFrames: 3,
  requiredReturnFrames: 2
};

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function computeYaw({ noseX, eyeCenterX = 300, eyeDistance = 200 }) {
  return (noseX - eyeCenterX) / eyeDistance;
}

function createEvaluator(challengeId) {
  return {
    challengeId,
    state: 'INIT',
    baselineSamples: [],
    baselineYaw: null,
    history: [],
    turnFrames: 0,
    returnFrames: 0,
    feed(yaw) {
      this.history = this.history.concat(yaw).slice(-CONFIG.smoothingWindow);
      const smoothed = median(this.history);
      if (this.baselineYaw === null) {
        this.baselineSamples = this.baselineSamples.concat(smoothed).slice(-CONFIG.baselineFrames);
        if (this.baselineSamples.length < CONFIG.baselineFrames) return false;
        this.baselineYaw = median(this.baselineSamples);
        this.state = 'NEUTRAL_CONFIRMED';
        return false;
      }

      const relative = smoothed - this.baselineYaw;
      const targetReached = this.challengeId === 'TURN_LEFT'
        ? relative >= CONFIG.turnThreshold
        : relative <= -CONFIG.turnThreshold;

      if (this.state === 'NEUTRAL_CONFIRMED' && targetReached) {
        this.turnFrames++;
        if (this.turnFrames >= CONFIG.requiredTurnFrames) {
          this.state = 'WAIT_RETURN';
          this.turnFrames = 0;
        }
      } else if (this.state === 'WAIT_RETURN' && Math.abs(relative) <= CONFIG.returnThreshold) {
        this.returnFrames++;
        if (this.returnFrames >= CONFIG.requiredReturnFrames) {
          this.state = 'CHALLENGE_COMPLETE';
          return true;
        }
      } else if (this.state === 'WAIT_RETURN') {
        this.returnFrames = 0;
      }
      return this.state === 'CHALLENGE_COMPLETE';
    }
  };
}

function run(label, challengeId, frames, expected) {
  const evaluator = createEvaluator(challengeId);
  let passed = false;
  frames.forEach(frame => { if (evaluator.feed(frame)) passed = true; });
  const ok = passed === expected;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} -> ${passed ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

const neutral = Array(8).fill(0.02);
const left = neutral.concat(Array(4).fill(0.20), Array(4).fill(0.03));
const right = neutral.concat(Array(4).fill(-0.20), Array(4).fill(0.03));
const smallLeft = neutral.concat(Array(8).fill(0.08), Array(4).fill(0.03));
const noMovement = Array(30).fill(0.02);

run('Physical LEFT passes LEFT challenge', 'TURN_LEFT', left, true);
run('Physical RIGHT passes RIGHT challenge', 'TURN_RIGHT', right, true);
run('Physical RIGHT fails LEFT challenge', 'TURN_LEFT', right, false);
run('Physical LEFT fails RIGHT challenge', 'TURN_RIGHT', left, false);
run('Small movement does not pass', 'TURN_LEFT', smallLeft, false);
run('No movement does not pass', 'TURN_RIGHT', noMovement, false);
run('Static photo does not pass', 'TURN_LEFT', noMovement, false);
