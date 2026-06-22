export interface ScheduledSend {
  readonly id: string;
  readonly sessionId: string;
  readonly message: string;
  readonly scheduledAt: Date;
  readonly createdAt: Date;
}

export function parseTimeInput(input: string, now: Date): Date | null {
  const match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  const result = new Date(now);
  result.setHours(hours, minutes, 0, 0);

  if (result <= now) {
    result.setDate(result.getDate() + 1);
  }

  return result;
}

export function formatTimeRemaining(scheduledAt: Date, now: Date): string {
  const diffMs = scheduledAt.getTime() - now.getTime();
  if (diffMs <= 0) return "0s";

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.join("") || "0s";
}

export function isScheduledSendDue(entry: ScheduledSend, now: Date): boolean {
  return now >= entry.scheduledAt;
}
