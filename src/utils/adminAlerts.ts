import type { Order } from './storeLogic';
import { formatINR } from './storeLogic';

let sharedAudioCtx: AudioContext | null = null;
let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

const SOUND_MUTED_KEY = 'bantuu_admin_alert_muted_v1';

export function isAlertSoundMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SOUND_MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAlertSoundMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUND_MUTED_KEY, muted ? '1' : '0');
  } catch {
    // ignore storage restrictions
  }
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    try {
      sharedAudioCtx = new Ctx();
    } catch {
      return null;
    }
  }
  return sharedAudioCtx;
}

export async function unlockAlertAudio(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

/**
 * Plays a crisp, bright iPhone-style crystal tri-tone chime using Web Audio API
 * (no external MP3 network dependencies, works offline & in WebViews).
 */
export async function playIphoneOrderChime(): Promise<boolean> {
  if (isAlertSoundMuted()) return false;
  const ctx = getAudioContext();
  if (!ctx) return false;

  try {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  } catch {
    return false;
  }

  try {
    const now = ctx.currentTime + 0.02;
    // Iconic bright iOS-style crystal chord chime (B5 -> D#6 -> F#6 -> B6 shimmer)
    const notes = [
      { freq: 987.77, start: 0.0, dur: 0.24, gain: 0.22 },
      { freq: 1244.51, start: 0.11, dur: 0.26, gain: 0.22 },
      { freq: 1479.98, start: 0.22, dur: 0.36, gain: 0.25 },
      { freq: 1975.53, start: 0.34, dur: 0.52, gain: 0.2 },
    ];

    for (const note of notes) {
      const startTime = now + note.start;

      const osc = ctx.createOscillator();
      const overtone = ctx.createOscillator();
      const noteGain = ctx.createGain();
      const overtoneGain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, startTime);

      overtone.type = 'triangle';
      overtone.frequency.setValueAtTime(note.freq * 2, startTime);

      noteGain.gain.setValueAtTime(0.0001, startTime);
      noteGain.gain.exponentialRampToValueAtTime(note.gain, startTime + 0.012);
      noteGain.gain.exponentialRampToValueAtTime(0.0001, startTime + note.dur);

      overtoneGain.gain.setValueAtTime(0.0001, startTime);
      overtoneGain.gain.exponentialRampToValueAtTime(note.gain * 0.28, startTime + 0.01);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, startTime + note.dur * 0.65);

      osc.connect(noteGain);
      overtone.connect(overtoneGain);
      noteGain.connect(ctx.destination);
      overtoneGain.connect(ctx.destination);

      osc.start(startTime);
      overtone.start(startTime);
      osc.stop(startTime + note.dur + 0.03);
      overtone.stop(startTime + note.dur + 0.03);
    }
    return true;
  } catch {
    return false;
  }
}

export function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js')
      .catch(() => null);
  }
  return swRegistrationPromise;
}

export type AlertPermissionState = NotificationPermission | 'unsupported';

export function getAlertPermissionState(): AlertPermissionState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestSystemNotificationPermission(): Promise<AlertPermissionState> {
  await unlockAlertAudio();
  await registerNotificationServiceWorker();
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function triggerOrderSystemNotification(order: Order): Promise<boolean> {
  const title = `New Order ${order.orderNumber} — ${formatINR(order.total)}`;
  const itemSummary = order.items.map((i) => `${i.name} ×${i.quantity}`).join(', ');
  const body = `${order.customerName} (${order.paymentMethod}) · ${order.city}\n${itemSummary}`;

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([220, 100, 220, 100, 300]);
    }
  } catch {
    // ignore vibrate failures
  }

  // Optional native Android WebView / wrapper JS bridge support
  try {
    const win = window as unknown as {
      Android?: { showNotification?: (t: string, b: string) => void };
      AndroidInterface?: { showNotification?: (t: string, b: string) => void };
      WebAppInterface?: { showNotification?: (t: string, b: string) => void };
      ReactNativeWebView?: { postMessage?: (msg: string) => void };
      flutter_inappwebview?: { callHandler?: (name: string, payload: unknown) => void };
    };
    win.Android?.showNotification?.(title, body);
    win.AndroidInterface?.showNotification?.(title, body);
    win.WebAppInterface?.showNotification?.(title, body);
    win.ReactNativeWebView?.postMessage?.(
      JSON.stringify({ type: 'NEW_ORDER', orderNumber: order.orderNumber, title, body }),
    );
    win.flutter_inappwebview?.callHandler?.('newOrderNotification', {
      orderNumber: order.orderNumber,
      title,
      body,
    });
  } catch {
    // ignore optional bridge errors
  }

  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  const options = {
    body,
    tag: `bantuu-order-${order.id}`,
    renotify: true,
    silent: false,
    icon: '/bantuu-icon.png',
    badge: '/bantuu-icon.png',
    vibrate: [220, 100, 220, 100, 300],
    requireInteraction: true,
    actions: [{ action: 'view', title: 'Open Admin Orders' }],
    data: { url: '/#admin', orderId: order.id },
  };

  try {
    const reg = await registerNotificationServiceWorker();
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, options);
      return true;
    }
  } catch {
    // fallback to Notification constructor below
  }

  try {
    const { actions: _omitActions, ...basicOptions } = options;
    new Notification(title, basicOptions);
    return true;
  } catch {
    return false;
  }
}
