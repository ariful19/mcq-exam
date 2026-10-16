import { gsap } from 'gsap';

let motionActive = true;
let activeScan = null;

export function isMobileOrLowEndDevice() {
  if (typeof window === 'undefined') return false;

  // 1. Modern Client Hints (Chromium / Android)
  if (navigator.userAgentData?.mobile) return true;

  // 2. User Agent heuristics for mobile / tablet devices
  const ua = navigator.userAgent || '';
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i.test(ua)) {
    return true;
  }

  // 3. Touch device with compact or medium screen
  const isTouch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const isSmallScreen = (typeof window.innerWidth === 'number' && window.innerWidth <= 1024) ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1024px)').matches);
  if (isTouch && isSmallScreen) return true;

  // 4. Low-end device hardware indicators (e.g. <= 4 logical cores or <= 4 GB RAM)
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return true;
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) return true;

  return false;
}

export function shouldEnableMotion(settings = {}) {
  // Global master setting (enabled unless set to '0' or false)
  const globalEnabled = settings.enable_animations !== '0' &&
    settings.enable_animations !== false &&
    settings.enable_animations !== 'false';
  if (!globalEnabled) return false;

  // Operating system reduced motion preference
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false;
    }
  }

  // Device-adaptive setting (enabled unless set to '0' or false)
  const autoDevice = settings.auto_device_animations !== '0' &&
    settings.auto_device_animations !== false &&
    settings.auto_device_animations !== 'false';
  if (autoDevice && isMobileOrLowEndDevice()) {
    return false;
  }

  return true;
}

export function setMotionActive(active) {
  motionActive = Boolean(active);
  activeScan?.();
}

export function isMotionActive() {
  return motionActive;
}

export function installMotion(app) {
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
  const seen = new WeakSet();
  const loops = new Map();
  const selector = 'main, .login-card, .exam-card, .stat-card, .admin-panel, .modal-card, .toast, .inline-error, .question-save-error, .result-card';
  const scan = () => {
    const isOff = !motionActive || media.matches;
    for (const [element, tween] of loops) {
      if (!element.isConnected || isOff) {
        tween.kill();
        gsap.set(element, { clearProps: 'transform' });
        loops.delete(element);
      }
    }
    if (isOff) return;
    app.querySelectorAll(selector).forEach(element => {
      if (seen.has(element)) return;
      seen.add(element);
      if (!motionActive || media.matches) return;
      const windowCard = element.matches('.login-card, .modal-card, .result-card');
      gsap.fromTo(element, { opacity: 0, y: windowCard ? 46 : 18, scale: windowCard ? .88 : .99, rotationX: windowCard ? -14 : 0, rotationY: windowCard ? -65 : 0, transformPerspective: 1000 },
        { opacity: 1, y: 0, scale: 1, rotationX: 0, rotationY: 0, duration: windowCard ? .7 : .45, ease: windowCard ? 'back.out(1.35)' : 'power2.out', clearProps: 'transform,opacity' });
      if (element.matches('.inline-error, .question-save-error')) {
        const card = element.closest('.login-card, .question-dialog, .admin-panel');
        if (card) gsap.to(card, { keyframes: { x: [-9, 9, -6, 6, 0] }, duration: .4, clearProps: 'transform' });
      }
    });
    if (motionActive && !media.matches) {
      app.querySelectorAll('.art-paper, .art-sun, .art-star, .art-orbit').forEach((element, index) => {
        if (loops.has(element)) return;
        loops.set(element, gsap.to(element, { y: index % 2 ? 12 : -12, rotation: `+=${index % 2 ? 5 : -5}`, duration: 3 + index * .4, repeat: -1, yoyo: true, ease: 'sine.inOut' }));
      });
    }
  };
  activeScan = scan;
  const observer = new MutationObserver(scan);
  observer.observe(app, { childList: true, subtree: true });
  const feedback = event => {
    if (!motionActive || media.matches) return;
    const button = event.target.closest('button');
    if (button && !button.disabled) gsap.fromTo(button, { scale: .96 }, { scale: 1, duration: .3, ease: 'back.out(2)', clearProps: 'transform' });
  };
  app.addEventListener('click', feedback);
  media.addEventListener('change', scan);
  scan();
  return () => {
    observer.disconnect();
    app.removeEventListener('click', feedback);
    media.removeEventListener('change', scan);
    loops.forEach(tween => tween.kill());
    gsap.killTweensOf(app.querySelectorAll('*'));
    if (activeScan === scan) activeScan = null;
  };
}

export function appear(element) {
  if (!element || !motionActive || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)) return;
  gsap.fromTo(element, { opacity: 0, y: 36, scale: .9, rotationY: -80, transformPerspective: 1100 }, { opacity: 1, y: 0, scale: 1, rotationY: 0, duration: .65, ease: 'back.out(1.2)', clearProps: 'transform,opacity' });
}

export async function disappear(element) {
  if (!element || !motionActive || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)) return;
  gsap.killTweensOf(element);
  await gsap.to(element, { opacity: 0, y: 24, scale: .94, rotationX: 8, duration: .22, ease: 'power2.in' });
  gsap.set(element, { clearProps: 'transform,opacity' });
}

export async function slideQuestion(element, direction, change) {
  if (!element || !motionActive || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)) {
    await change();
    return;
  }
  await gsap.to(element, { x: -direction * 65, opacity: 0, duration: .18, ease: 'power2.in' });
  await change();
  if (!element.isConnected) return;
  await gsap.fromTo(element, { x: direction * 65, opacity: 0, rotationY: direction * 5, transformPerspective: 1000 }, { x: 0, opacity: 1, rotationY: 0, duration: .38, ease: 'power3.out', clearProps: 'transform,opacity' });
}
