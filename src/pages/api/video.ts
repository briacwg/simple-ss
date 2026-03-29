/**
 * POST /api/video
 *
 * Proxies a video consultation session creation request to the
 * video.servicesurfer.app microservice and returns the session URL.
 *
 * A unique `callSessionId` is generated on each request so the video service
 * can correlate the session back to the originating consumer request.
 */

import type { APIRoute } from 'astro';
import { json } from '../../lib/api-helpers';

export const prerender = false;

const VIDEO_BASE = import.meta.env.VIDEO_APP_URL || 'https://video.servicesurfer.app';

export const POST: APIRoute = async ({ request }) => {
  const { problem = '', location = '', businessName = '' } = await request.json().catch(() => ({}));

  const res = await fetch(`${VIDEO_BASE}/api/video/create-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Unique ID to correlate this session in the video service's logs
      callSessionId: `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      problem: String(problem).slice(0, 180) || 'Need help with a local service issue',
      location: String(location).slice(0, 120) || undefined,
      voiceContext: {
        source: 'simple-ss',
        businessName: String(businessName).slice(0, 180) || undefined,
      },
    }),
  }).catch(() => null);

  if (!res?.ok) return json({ error: 'video unavailable' }, 502);
  const data = await res.json().catch(() => null);
  if (!data?.link) return json({ error: 'video unavailable' }, 502);

  return json({ sessionUrl: data.link });
};

