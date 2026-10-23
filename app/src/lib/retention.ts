/**
 * Ebbinghaus Forgetting Curve & Spaced Repetition Calculations
 *
 * Formula: R = exp(-t / S)
 *   R: Retention rate (0.0 to 1.0)
 *   t: Elapsed time in days since last study / review
 *   S: Stability factor (interval in days based on review stage)
 */

export interface RetentionInfo {
  rate: number; // 0.0 to 1.0
  percentage: number; // 0 to 100
  color: string;
  statusText: string;
  isDue: boolean;
}

export function calculateRetention(
  lastReviewedAt: string | Date | null | undefined,
  intervalDays = 1,
  now = new Date(),
): RetentionInfo {
  if (!lastReviewedAt) {
    return {
      rate: 1.0,
      percentage: 100,
      color: '#10b981',
      statusText: 'Fresh',
      isDue: true,
    };
  }

  const lastDate = typeof lastReviewedAt === 'string' ? new Date(lastReviewedAt) : lastReviewedAt;
  const elapsedMs = Math.max(0, now.getTime() - lastDate.getTime());
  const elapsedDays = elapsedMs / 86400000;

  const S = Math.max(0.5, intervalDays);
  // Exponential decay
  const rate = Math.max(0, Math.min(1, Math.exp(-elapsedDays / S)));
  const percentage = Math.round(rate * 100);

  let color = '#10b981'; // green > 80%
  let statusText = 'Strong';
  if (percentage < 50) {
    color = '#ef4444'; // red < 50%
    statusText = 'Critical';
  } else if (percentage < 80) {
    color = '#f59e0b'; // yellow 50-80%
    statusText = 'Fading';
  }

  return {
    rate,
    percentage,
    color,
    statusText,
    // A card that has never been reviewed is due immediately; otherwise due
    // once elapsed time passes the stability interval.
    isDue: !lastReviewedAt ? true : elapsedDays >= S,
  };
}
