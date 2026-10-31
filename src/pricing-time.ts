/** Provider clock rules. Local wall time is accepted only with an explicit UTC offset. */
export const DEEPSEEK_SCHEDULE_ID = 'deepseek-2026-10-31';
export const pricingSchedule = {
  id: DEEPSEEK_SCHEDULE_ID,
  time_zone: 'Asia/Shanghai',
  peak_hours: [['09:00', '12:00'], ['14:00', '18:00']],
  peak_weekdays: [1, 2, 3, 4, 5],
  off_peak_multiplier: 0.5,
  holiday_years: [2026],
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  calendar_source: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
} as const;
export type PricePeriod = 'peak' | 'off_peak' | 'mixed' | 'unknown';
export type Timestamp = number | string | Date;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR; // Asia/Shanghai uses UTC+08 throughout the supported calendar.

// State Council 2026 public holiday periods. Weekend make-up work days remain off-peak:
// DeepSeek explicitly prices every Saturday/Sunday off-peak, independently of work rosters.
const holidays2026 = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'],
  ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
] as const;

function timestamp(value: Timestamp): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  // Never interpret a naive local date using the machine's current zone or DST guess.
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  return Date.parse(value);
}

/** Conservative whole-request classification: any peak overlap prevents an off-peak discount. */
export function requestPricePeriod(start: Timestamp, finish: Timestamp): PricePeriod {
  const from = timestamp(start), to = timestamp(finish);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 32 * DAY ||
      Math.abs(from) > 8.64e15 - DAY || Math.abs(to) > 8.64e15 - DAY) return 'unknown';
  let peak = false, off = false;
  const firstDay = Math.floor((from + BEIJING_OFFSET) / DAY) * DAY;
  const lastDay = Math.floor((to + BEIJING_OFFSET) / DAY) * DAY;
  for (let day = firstDay; day <= lastDay; day += DAY) {
    const date = new Date(day);
    if (date.getUTCFullYear() !== 2026) return 'unknown';
    const mmdd = date.toISOString().slice(5, 10);
    const holiday = holidays2026.some(([first, last]) => mmdd >= first && mmdd <= last);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    if (holiday || weekend) { off = true; continue; }
    const startOfDay = day - BEIJING_OFFSET;
    const overlaps = (lo: number, hi: number) => from < startOfDay + hi * HOUR && to >= startOfDay + lo * HOUR;
    if (overlaps(9, 12) || overlaps(14, 18)) peak = true;
    if (overlaps(0, 9) || overlaps(12, 14) || overlaps(18, 24)) off = true;
  }
  return peak ? off ? 'mixed' : 'peak' : 'off_peak';
}
