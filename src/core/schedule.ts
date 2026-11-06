export interface Schedule {
  enabled: boolean;
  days: number[];
  hour: number;
  minute: number;
}

export const DEFAULT_SCHEDULE: Schedule = { enabled: true, days: [0], hour: 3, minute: 0 };

const SCHTASKS_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function validateSchedule(schedule: Schedule): string[] {
  const errors: string[] = [];
  if (schedule.days.length === 0) errors.push('at least one day is required');
  if (schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) errors.push('days must be 0-6');
  if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) errors.push('hour must be 0-23');
  if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) errors.push('minute must be 0-59');
  return errors;
}

export function nextRun(schedule: Schedule, from: Date): Date | null {
  if (!schedule.enabled || validateSchedule(schedule).length > 0) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const run = new Date(from);
    run.setDate(from.getDate() + offset);
    run.setHours(schedule.hour, schedule.minute, 0, 0);
    if (schedule.days.includes(run.getDay()) && run > from) return run;
  }
  return null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function launchdPlist(schedule: Schedule, label: string, program: string[]): string {
  const args = program.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  const intervals = [...new Set(schedule.days)]
    .sort()
    .map(
      (day) =>
        `    <dict>\n      <key>Weekday</key><integer>${day}</integer>\n      <key>Hour</key><integer>${schedule.hour}</integer>\n      <key>Minute</key><integer>${schedule.minute}</integer>\n    </dict>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
</dict>
</plist>
`;
}

export function schtasksArgs(schedule: Schedule, taskName: string, command: string): string[] {
  const pad = (value: number) => String(value).padStart(2, '0');
  const days = [...new Set(schedule.days)].sort().map((day) => SCHTASKS_DAYS[day]).join(',');
  return ['/Create', '/F', '/TN', taskName, '/TR', command, '/SC', 'WEEKLY', '/D', days, '/ST', `${pad(schedule.hour)}:${pad(schedule.minute)}`];
}
