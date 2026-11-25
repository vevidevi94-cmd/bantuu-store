/**
 * Standalone Node.js UPI Payment Status Polling Script (Firebase Realtime Database).
 *
 * Polls `/upiPayments` in Firebase Realtime Database for `Pending` transactions,
 * checks payment confirmation status (simulated gateway verification or custom provider hook),
 * and updates confirmed transaction nodes to `status: "Paid"` in Firebase RTDB.
 *
 * Usage:
 *   npx tsx server/upiStatusPoller.ts --once
 *   npx tsx server/upiStatusPoller.ts --interval=5000 --auto-confirm-age-ms=10000
 */
import crypto from 'node:crypto';
import {
  fetchAllUpiPaymentsFromRtdb,
  patchUpiPaymentInRtdb,
} from './firebaseRtdb.js';
import type { UpiPaymentRecord } from '../src/utils/upiPaymentLogic.js';

const DEFAULT_RTDB_URL =
  process.env.FIREBASE_RTDB_URL || 'https://bantuu-store-default-rtdb.firebaseio.com';

export interface PollCycleOptions {
  rtdbUrl?: string;
  /**
   * Simulates bank/PSP settlement for pending sandbox transactions older than this threshold (ms).
   * In production, replace `checkGatewayStatus` with your PSP/bank status API call.
   */
  autoConfirmAgeMs?: number;
  checkGatewayStatus?: (
    payment: UpiPaymentRecord,
  ) => Promise<{ confirmed: boolean; utr?: string; providerRef?: string }>;
}

async function defaultSimulatedGatewayCheck(
  payment: UpiPaymentRecord,
  autoConfirmAgeMs: number,
): Promise<{ confirmed: boolean; utr?: string; providerRef?: string }> {
  const createdMs = Date.parse(payment.createdAt || '');
  if (!Number.isFinite(createdMs)) return { confirmed: false };
  const ageMs = Date.now() - createdMs;
  if (ageMs < autoConfirmAgeMs) {
    return { confirmed: false };
  }
  const simulatedUtr = `4${crypto.randomInt(10000000000, 99999999999)}`;
  return {
    confirmed: true,
    utr: payment.utr || simulatedUtr,
    providerRef: `POLL-SIM-${Date.now()}`,
  };
}

export async function runUpiStatusPollCycle(
  options: PollCycleOptions = {},
): Promise<{ checked: number; updatedToPaid: string[] }> {
  const rtdbUrl = options.rtdbUrl || DEFAULT_RTDB_URL;
  const autoConfirmAgeMs = options.autoConfirmAgeMs ?? 15000;
  const payments = await fetchAllUpiPaymentsFromRtdb<UpiPaymentRecord>(rtdbUrl);
  const pending = payments.filter(
    (p) => (p.status === 'Pending' || p.status === 'Pending Verification') && p.transactionId,
  );

  const updatedToPaid: string[] = [];

  for (const payment of pending) {
    const result = options.checkGatewayStatus
      ? await options.checkGatewayStatus(payment)
      : await defaultSimulatedGatewayCheck(payment, autoConfirmAgeMs);

    if (result.confirmed) {
      const nowIso = new Date().toISOString();
      const ok = await patchUpiPaymentInRtdb(rtdbUrl, payment.transactionId, {
        status: 'Paid',
        utr: result.utr || payment.utr || `UTR${Date.now()}`,
        providerRef: result.providerRef || 'UPI-POLLER',
        paidAt: nowIso,
        updatedAt: nowIso,
      });
      if (ok) {
        updatedToPaid.push(payment.transactionId);
      }
    }
  }

  return { checked: pending.length, updatedToPaid };
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('upiStatusPoller.ts');

if (isDirectExecution) {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  const ageArg = args.find((a) => a.startsWith('--auto-confirm-age-ms='));
  const intervalMs = Math.max(2000, Number(intervalArg?.split('=')[1] || 5000));
  const autoConfirmAgeMs = Math.max(1000, Number(ageArg?.split('=')[1] || 10000));

  const tick = async () => {
    const summary = await runUpiStatusPollCycle({ autoConfirmAgeMs });
    console.log(
      `[UPI Poller] Checked ${summary.checked} pending transaction(s); marked Paid: ${
        summary.updatedToPaid.length ? summary.updatedToPaid.join(', ') : 'none'
      }`,
    );
  };

  if (runOnce) {
    tick().catch((err) => {
      console.error('[UPI Poller] Error:', err);
      process.exitCode = 1;
    });
  } else {
    console.log(`[UPI Poller] Started (interval=${intervalMs}ms, autoConfirmAgeMs=${autoConfirmAgeMs}ms)`);
    tick().catch((err) => console.error('[UPI Poller] Error:', err));
    setInterval(() => {
      tick().catch((err) => console.error('[UPI Poller] Error:', err));
    }, intervalMs);
  }
}
