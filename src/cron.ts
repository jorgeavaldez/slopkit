/** Cron for scheduled work: five fields (minute hour day-of-month month day-of-week) in local time. */

type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
};

const MACROS = new Map([
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
]);

function cronField(text: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();

  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);

    if (match === null) {
      throw new Error(`Invalid cron ${label}: ${part}`);
    }

    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = min;
    let to = max;

    if (match[1] !== "*") {
      from = Number(match[2]);
      to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
    }

    if (step < 1 || from < min || to > max || from > to) {
      throw new Error(`Invalid cron ${label}: ${part} (allowed ${min}-${max})`);
    }

    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }

  return values;
}

/** Parse a five-field cron expression or one of @hourly, @daily, @weekly, @monthly. */
export function parseCron(expression: string): Cron {
  const fields = (MACROS.get(expression.trim()) ?? expression).trim().split(/\s+/);
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;

  if (fields.length !== 5) {
    throw new Error(`Cron needs five fields: ${expression}`);
  }

  const weekdays = cronField(weekday, 0, 7, "day of week");

  // 7 is Sunday too.
  if (weekdays.delete(7)) {
    weekdays.add(0);
  }

  return {
    minute: cronField(minute, 0, 59, "minute"),
    hour: cronField(hour, 0, 23, "hour"),
    day: cronField(day, 1, 31, "day of month"),
    month: cronField(month, 1, 12, "month"),
    weekday: weekdays,
    anyDay: day === "*",
    anyWeekday: weekday === "*",
  };
}

/** The first slot strictly after `after`, in local time; DST gaps are skipped. */
export function nextSlot(cron: Cron, after: number): number {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  // Five years of days bounds expressions that never match, like February 30.
  for (let steps = 0; steps < 100_000; steps++) {
    const dayMatches =
      cron.anyDay && cron.anyWeekday
        ? true
        : cron.anyDay
          ? cron.weekday.has(date.getDay())
          : cron.anyWeekday
            ? cron.day.has(date.getDate())
            : cron.day.has(date.getDate()) || cron.weekday.has(date.getDay());

    if (!cron.month.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
    } else if (!dayMatches) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (!cron.hour.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
    } else if (cron.minute.has(date.getMinutes())) {
      return date.getTime();
    } else {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
    }
  }

  throw new Error("Cron expression has no upcoming slot");
}
