import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, X } from 'lucide-react';
import { setAdminSessionToken } from '../utils/adminClientAuth';
import { registerNotificationServiceWorker, unlockAlertAudio } from '../utils/adminAlerts';

interface AdminPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AdminPasswordModal({ isOpen, onClose, onSuccess }: AdminPasswordModalProps) {
  const [passcode, setPasscode] = useState('');
  const [showPasscode, setShowPasscode] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPasscode('');
      setError('');
      setShowPasscode(false);
      setSubmitting(false);
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 40);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) {
      setError('Please enter your admin password.');
      return;
    }

    setError('');
    setSubmitting(true);
    void unlockAlertAudio();
    void registerNotificationServiceWorker();
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ passcode }),
      });
      const text = await res.text();
      let data: { authenticated?: boolean; token?: string; error?: string } = {};
      try {
        data = text ? (JSON.parse(text) as { authenticated?: boolean; token?: string; error?: string }) : {};
      } catch {
        data = {};
      }

      if (!res.ok || !data.authenticated) {
        setError(data.error || 'Incorrect admin password. Please try again.');
        return;
      }

      setAdminSessionToken(data.token);
      setPasscode('');
      onSuccess();
    } catch {
      setError('Unable to reach authentication server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#091322]/75 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-passcode-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white border border-[#DED8C8] rounded-xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-[#172A46] border border-[#223654] inline-flex items-center justify-center text-[#C6A45C]">
              <Lock className="w-4 h-4" />
            </span>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-[#C6A45C] font-semibold">
                Protected Access
              </p>
              <h2 id="admin-passcode-title" className="text-base font-semibold text-[#F7F5EE]">
                Admin Studio Verification
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close admin verification modal"
            className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] hover:bg-[#1F3659] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-[#3E4756]">
            Enter the Bantuu Store administrator password to open Orders, Products, and Categories management.
          </p>

          <div>
            <label
              htmlFor="admin-passcode-input"
              className="block text-xs font-medium text-[#3E4756] mb-1.5"
            >
              Admin Password
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="admin-passcode-input"
                type={showPasscode ? 'text' : 'password'}
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Enter admin password"
                autoComplete="current-password"
                className="w-full pl-3.5 pr-10 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] bg-[#F7F5EE] focus:bg-white focus:outline-none focus:border-[#0F1D32]"
              />
              <button
                type="button"
                onClick={() => setShowPasscode((prev) => !prev)}
                aria-label={showPasscode ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#5C5852] hover:text-[#0F1D32] cursor-pointer"
              >
                {showPasscode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-1.5 text-xs text-[#B91C1C] font-medium">
                {error}
              </p>
            )}
          </div>

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] hover:bg-[#F7F5EE] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 text-sm font-semibold rounded-lg bg-[#0F1D32] text-[#F7F5EE] hover:bg-[#172A46] disabled:opacity-60 cursor-pointer"
            >
              {submitting ? 'Verifying...' : 'Unlock Admin Panel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
