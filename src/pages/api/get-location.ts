/**
 * GET /api/get-location
 * IP geolocation + reverse geocoding (same as main app).
 * ?lat=X&lon=Y → reverse geocode to city/zip
 * (no params)  → IP-based geolocation
 */

import type { APIRoute } from 'astro';
import { getClientIp, fetchWithTimeout } from '../../lib/api-helpers';

export const prerender = false;

const cors    = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const jsonRes = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

export const OPTIONS: APIRoute = async () => new Response(null, { status: 204, headers: cors });

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const lat = url.searchParams.get('lat'), lon = url.searchParams.get('lon');

  // Reverse geocode coordinates → zip/city
  if (lat && lon) {
    const key = import.meta.env.GOOGLE_PLACES_API_KEY;
    if (!key) return jsonRes({ error: 'no key' }, 500);
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${key}`).catch(() => null);
    if (!r?.ok) return jsonRes({ success: false });
    const data = await r.json();
    let zip = null, city = null;
    for (const result of data.results || []) {
      for (const c of result.address_components || []) {
        if (c.types.includes('postal_code') && !zip) zip = c.long_name;
        if ((c.types.includes('locality') || c.types.includes('administrative_area_level_2')) && !city) city = c.long_name;
      }
      if (zip) break;
    }
    return jsonRes({ success: true, location: { zipCode: zip, city } });
  }

  // IP geolocation — race two providers, take the first to respond
  const ip      = getClientIp(request);
  const geoInit = { headers: { 'User-Agent': 'ServiceSurfer/1.0' } };

  const tryIpApi = async () => {
    const r = await fetchWithTimeout(
      ip !== 'unknown'
        ? `https://ip-api.com/json/${ip}?fields=status,country,regionName,city,zip,lat,lon`
        : 'https://ip-api.com/json?fields=status,country,regionName,city,zip,lat,lon',
      1200, geoInit,
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 'success') return null;
    return { zipCode: d.zip, city: d.city, state: d.regionName, country: d.country, lat: d.lat, lon: d.lon, source: 'ip-api' };
  };

  const tryIpApiCo = async () => {
    const r = await fetchWithTimeout(
      ip !== 'unknown' ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/',
      1200, geoInit,
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (d.error) return null;
    return { zipCode: d.postal, city: d.city, state: d.region, country: d.country_name, lat: d.latitude, lon: d.longitude, source: 'ipapi.co' };
  };

  try {
    const loc = await Promise.any([tryIpApi(), tryIpApiCo()].map(p => p.then(r => r ?? Promise.reject('no-data'))));
    return jsonRes({ success: true, location: loc });
  } catch {
    return jsonRes({ success: false, error: 'could not detect location' });
  }
};
