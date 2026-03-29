/**
 * GET /api/get-location
 * IP geolocation + reverse geocoding (same as main app).
 * ?lat=X&lon=Y → reverse geocode to city/zip
 * (no params)  → IP-based geolocation
 */

import type { APIRoute } from 'astro';

export const prerender = false;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: cors });

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const lat = url.searchParams.get('lat'), lon = url.searchParams.get('lon');
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

  // Reverse geocode coordinates → zip/city
  if (lat && lon) {
    const key = import.meta.env.GOOGLE_PLACES_API_KEY;
    if (!key) return json({ error: 'no key' }, 500);
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${key}`).catch(() => null);
    if (!r?.ok) return json({ success: false });
    const data = await r.json();
    let zip = null, city = null;
    for (const result of data.results || []) {
      for (const c of result.address_components || []) {
        if (c.types.includes('postal_code') && !zip) zip = c.long_name;
        if ((c.types.includes('locality') || c.types.includes('administrative_area_level_2')) && !city) city = c.long_name;
      }
      if (zip) break;
    }
    return json({ success: true, location: { zipCode: zip, city } });
  }

  // IP geolocation
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || request.headers.get('x-real-ip') || '';
  const timeout = (url: string, ms = 1200) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal, headers: { 'User-Agent': 'ServiceSurfer/1.0' } });
  };

  const tryIpApi = async () => {
    const r = await timeout(ip ? `https://ip-api.com/json/${ip}?fields=status,country,regionName,city,zip,lat,lon` : 'https://ip-api.com/json?fields=status,country,regionName,city,zip,lat,lon');
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 'success') return null;
    return { zipCode: d.zip, city: d.city, state: d.regionName, country: d.country, lat: d.lat, lon: d.lon, source: 'ip-api' };
  };

  const tryIpApiCo = async () => {
    const r = await timeout(ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/');
    if (!r.ok) return null;
    const d = await r.json();
    if (d.error) return null;
    return { zipCode: d.postal, city: d.city, state: d.region, country: d.country_name, lat: d.latitude, lon: d.longitude, source: 'ipapi.co' };
  };

  try {
    const loc = await Promise.any([tryIpApi(), tryIpApiCo()].map(p => p.then(r => r ?? Promise.reject('no-data'))));
    return json({ success: true, location: loc });
  } catch {
    return json({ success: false, error: 'could not detect location' });
  }
};
