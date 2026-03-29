/**
 * POST /api/voice — all Twilio voice webhooks in one handler.
 *
 * Configure your Twilio number Voice URL → https://your-domain/api/voice
 * Configure Status Callback URL → https://your-domain/api/voice (optional)
 *
 * Cases handled:
 *   ?t={token}   → outbound click-to-call: user answered, now bridge to business
 *   Digits=NNNNNN → PIN submitted: look up session and bridge
 *   (default)    → gather 6-digit PIN, fallback to AI voice agent
 */

import type { APIRoute } from 'astro';
import { getCallSession, getCallSessionByPin, bridgeNumber } from '../../lib';

export const prerender = false;

const AI_AGENT = 'https://voice.servicesurfer.app/api/inbound';

function twiml(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

function x(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export const POST: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || '';

  let digits = '';
  try { digits = String((await request.formData()).get('Digits') || '').replace(/\D/g, ''); } catch {}

  // Outbound: Twilio called the user, they answered — bridge directly to business
  if (token) {
    const s = await getCallSession(token);
    if (!s) return twiml('<Say voice="Polly.Joanna-Neural">This call link has expired. Goodbye.</Say><Hangup/>');
    return twiml(`<Say voice="Polly.Joanna-Neural">Connecting you to ${x(s.businessName)} now.</Say><Dial answerOnBridge="true" callerId="${x(bridgeNumber())}">${x(s.businessPhone)}</Dial><Hangup/>`);
  }

  // PIN submitted via DTMF or Gather
  if (digits.length === 6) {
    const s = await getCallSessionByPin(digits);
    if (s) return twiml(`<Say voice="Polly.Joanna-Neural">Connecting you to ${x(s.businessName)} now.</Say><Dial answerOnBridge="true" callerId="${x(bridgeNumber())}">${x(s.businessPhone)}</Dial><Hangup/>`);
  }

  // Initial inbound — gather PIN; if no valid PIN entered, forward to AI agent
  return twiml(`<Gather numDigits="6" action="${x(url.origin)}/api/voice" method="POST" timeout="8"><Say voice="Polly.Joanna-Neural">Welcome to ServiceSurfer. Enter your 6-digit connection code, or stay on the line for assistance.</Say></Gather><Redirect method="POST">${x(AI_AGENT)}</Redirect>`);
};

export const GET = POST;
