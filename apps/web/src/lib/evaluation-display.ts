type ScoreLevel = {
  label: string;
  shortLabel: string;
  description: string;
};

export function displayScore(score: number, allScores: number[]): number {
  const divisor = lowScaleDivisor(allScores);
  if (divisor) return clampScore((score / divisor) * 100);
  return clampScore(score);
}

export function averageDisplayScore(scores: number[], fallback: number): number {
  if (!scores.length) return clampScore(fallback);
  const normalized = scores.map((score) => displayScore(score, scores));
  return clampScore(normalized.reduce((sum, score) => sum + score, 0) / normalized.length);
}

export function scoreLevel(score: number): ScoreLevel {
  if (score >= 80) {
    return {
      label: "안정적 이해",
      shortLabel: "안정",
      description: "코드 근거와 흐름을 안정적으로 연결했습니다."
    };
  }
  if (score >= 60) {
    return {
      label: "대체로 이해",
      shortLabel: "양호",
      description: "핵심 흐름은 잡았고 일부 근거를 더 보강하면 좋습니다."
    };
  }
  if (score >= 40) {
    return {
      label: "부분 이해",
      shortLabel: "부분",
      description: "일부 맥락은 맞지만 파일, 흐름, 영향 범위를 더 연결해야 합니다."
    };
  }
  return {
    label: "보강 필요",
    shortLabel: "보강",
    description: "코드 근거를 다시 확인하고 답변 구조를 재정리하는 것이 좋습니다."
  };
}

function lowScaleDivisor(scores: number[]): number | null {
  const finiteScores = scores.filter((score) => Number.isFinite(score));
  if (!finiteScores.length) return null;
  const max = Math.max(...finiteScores);
  if (max <= 0) return null;
  if (max <= 2) return 2;
  if (max <= 5) return 5;
  return null;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}
