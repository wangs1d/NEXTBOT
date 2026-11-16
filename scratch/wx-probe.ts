import { geocodeCity } from "../server/src/services/weather-service.js";
const geo = await geocodeCity("成都");
console.log("geocode:", JSON.stringify(geo));
const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${geo?.latitude}&longitude=${geo?.longitude}&timezone=auto&daily=weather_code,temperature_2m_max&forecast_days=16`);
console.log("open-meteo status:", res.status, "days:", (await res.json()).daily?.time?.length);
