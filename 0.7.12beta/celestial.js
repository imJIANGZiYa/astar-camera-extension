(() => {
  const degrees = (value) => value * 180 / Math.PI;
  const normalize = (value) => (value % 360 + 360) % 360;
  const validCoordinate = (value, limit) => Number.isFinite(value) && Math.abs(value) <= limit;

  const parseShanghaiTime = (dateText, timeText) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(timeText)) {
      throw new Error("日期或时间格式不正确。");
    }
    const normalizedTime = timeText.length === 5 ? `${timeText}:00` : timeText;
    const date = new Date(`${dateText}T${normalizedTime}+08:00`);
    if (!Number.isFinite(date.getTime())) throw new Error("日期或时间无效。");
    return date;
  };

  const position = (body, date, latitude, longitude) => {
    const raw = body === "sun"
      ? SunCalc.getPosition(date, latitude, longitude)
      : SunCalc.getMoonPosition(date, latitude, longitude);
    return {
      azimuth: normalize(degrees(raw.azimuth) + 180),
      altitude: degrees(raw.altitude)
    };
  };

  const trajectory = (body, dateText, latitude, longitude) => {
    const samples = [];
    for (let minute = 0; minute <= 24 * 60; minute += 20) {
      const hours = String(Math.floor(minute / 60) % 24).padStart(2, "0");
      const minutes = String(minute % 60).padStart(2, "0");
      const date = minute === 24 * 60
        ? new Date(parseShanghaiTime(dateText, "00:00").getTime() + 86400000)
        : parseShanghaiTime(dateText, `${hours}:${minutes}`);
      const value = position(body, date, latitude, longitude);
      samples.push({ ...value, visible: value.altitude >= 0 });
    }
    return samples;
  };

  const timeLabel = (date) => Number.isFinite(date?.getTime?.())
    ? new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date)
    : "—";

  const calculate = (dateText, timeText, latitude, longitude) => {
    if (!validCoordinate(latitude, 90) || !validCoordinate(longitude, 180)) {
      throw new Error("请先点选场景中的中心位置。");
    }
    const date = parseShanghaiTime(dateText, timeText);
    const sun = position("sun", date, latitude, longitude);
    const moon = position("moon", date, latitude, longitude);
    const illumination = SunCalc.getMoonIllumination(date);
    const sunTimes = SunCalc.getTimes(date, latitude, longitude);
    // Collect both UTC days intersecting the selected Shanghai calendar day.
    // SunCalc's UTC day otherwise changes at Shanghai 08:00, giving wrong events.
    const localStart = parseShanghaiTime(dateText, "00:00");
    const localEnd = new Date(localStart.getTime() + 86400000);
    const utcStart = Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth(), localStart.getUTCDate());
    const moonTimes = {};
    for (let day = 0; day < 2; day++) {
      const times = SunCalc.getMoonTimes(new Date(utcStart + day * 86400000), latitude, longitude, true);
      for (const key of ["rise", "set"]) {
        const event = times[key];
        if (event >= localStart && event < localEnd) moonTimes[key] = event;
      }
    }
    return {
      date: date.toISOString(),
      sun,
      moon: { ...moon, illumination: illumination.fraction * 100 },
      events: {
        sunrise: timeLabel(sunTimes.sunrise),
        sunset: timeLabel(sunTimes.sunset),
        moonrise: timeLabel(moonTimes.rise),
        moonset: timeLabel(moonTimes.set)
      },
      trajectories: {
        sun: trajectory("sun", dateText, latitude, longitude),
        moon: trajectory("moon", dateText, latitude, longitude)
      }
    };
  };

  globalThis.cityCelestial = { calculate, parseShanghaiTime };
})();
