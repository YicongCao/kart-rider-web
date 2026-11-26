export function formatTime(milliseconds: number | null, includeMinutes = true) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return includeMinutes ? "--:--.---" : "--.---";
  }
  const total = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  if (!includeMinutes) {
    return `${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

export function formatDistance(meters: number) {
  return `${(meters / 1000).toFixed(1)} km`;
}

export function starRating(difficulty: number) {
  const filled = Math.max(1, Math.min(3, Math.round(difficulty)));
  return "●".repeat(filled) + "○".repeat(3 - filled);
}
