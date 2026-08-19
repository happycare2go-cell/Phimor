// utils/nameMatch.js
// จับคู่ชื่อที่ AI อ่านได้จากเอกสาร กับทะเบียนผู้พักของศูนย์ (FR-D)
//
// กติกาสำคัญ (ตาม Requirements ข้อ D2, D3):
// - มั่นใจสูง → ไปขั้นยืนยันทันที
// - ไม่มั่นใจ หรือมีชื่อใกล้เคียงมากกว่า 1 คน → ต้องถาม ห้ามเดา

function levenshtein(a, b) {
  a = (a || '').trim();
  b = (b || '').trim();
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** คะแนนความคล้าย 0..1 (1 = เหมือนเป๊ะ) */
function similarity(a, b) {
  const A = (a || '').trim();
  const B = (b || '').trim();
  if (!A || !B) return 0;
  const dist = levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

const HIGH_CONFIDENCE = 0.82; // ค่าเริ่มต้น — ต้องปรับจริงหลังทดลองกับเอกสารจริง (ดู Technical Design หมวด 9)

/**
 * @param {string} nameGuess ชื่อที่ AI อ่านได้จากเอกสาร
 * @param {Array<{resident_id, full_name, aliases}>} residents ทะเบียนผู้พักของศูนย์เดียวเท่านั้น
 * @returns {{ matched: object|null, needsSelection: boolean, candidates: Array }}
 */
function matchResident(nameGuess, residents) {
  if (!nameGuess || residents.length === 0) {
    return { matched: null, needsSelection: true, candidates: residents };
  }

  const scored = residents.map((r) => {
    const namesToCheck = [r.full_name, ...(r.aliases || [])];
    const best = Math.max(...namesToCheck.map((n) => similarity(nameGuess, n)));
    return { resident: r, score: best };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];

  // มั่นใจสูงและไม่มีคนอื่นใกล้เคียงจนแยกไม่ออก → ตัดสินใจได้เลย
  if (top && top.score >= HIGH_CONFIDENCE && (!second || top.score - second.score >= 0.12)) {
    return { matched: top.resident, needsSelection: false, candidates: [] };
  }

  // ไม่มั่นใจ หรือมีมากกว่าหนึ่งคนใกล้เคียงกัน → ต้องถาม ห้ามเดา (ข้อ D3)
  const candidates = scored.filter((s) => s.score >= 0.35).slice(0, 13).map((s) => s.resident); // Quick Reply สูงสุด 13 (ข้อ D4)
  return { matched: null, needsSelection: true, candidates: candidates.length ? candidates : residents.slice(0, 13) };
}

module.exports = { levenshtein, similarity, matchResident, HIGH_CONFIDENCE };
