import { gsap } from 'gsap';

export function installMotion(app) {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const seen = new WeakSet();
  const loops = new Map();
  const selector = 'main, .login-card, .exam-card, .stat-card, .admin-panel, .modal-card, .toast, .inline-error, .question-save-error, .result-card';
  const scan = () => {
    for (const [element, tween] of loops) {
      if (!element.isConnected || media.matches) { tween.kill(); gsap.set(element, { clearProps: 'transform' }); loops.delete(element); }
    }
    app.querySelectorAll(selector).forEach(element => {
      if (seen.has(element)) return;
      seen.add(element);
      if (media.matches) return;
      const windowCard = element.matches('.login-card, .modal-card, .result-card');
      gsap.fromTo(element, { opacity: 0, y: windowCard ? 46 : 18, scale: windowCard ? .88 : .99, rotationX: windowCard ? -14 : 0, rotationY: windowCard ? -65 : 0, transformPerspective: 1000 },
        { opacity: 1, y: 0, scale: 1, rotationX: 0, rotationY: 0, duration: windowCard ? .7 : .45, ease: windowCard ? 'back.out(1.35)' : 'power2.out', clearProps: 'transform,opacity' });
      if (element.matches('.inline-error, .question-save-error')) {
        const card = element.closest('.login-card, .question-dialog, .admin-panel');
        if (card) gsap.to(card, { keyframes: { x: [-9, 9, -6, 6, 0] }, duration: .4, clearProps: 'transform' });
      }
    });
    if (!media.matches) app.querySelectorAll('.art-paper, .art-sun, .art-star, .art-orbit').forEach((element, index) => {
      if (loops.has(element)) return;
      loops.set(element, gsap.to(element, { y: index % 2 ? 12 : -12, rotation: `+=${index % 2 ? 5 : -5}`, duration: 3 + index * .4, repeat: -1, yoyo: true, ease: 'sine.inOut' }));
    });
  };
  const observer = new MutationObserver(scan);
  observer.observe(app, { childList: true, subtree: true });
  const feedback = event => {
    const button = event.target.closest('button');
    if (button && !button.disabled && !media.matches) gsap.fromTo(button, { scale: .96 }, { scale: 1, duration: .3, ease: 'back.out(2)', clearProps: 'transform' });
  };
  app.addEventListener('click', feedback);
  media.addEventListener('change', scan);
  scan();
  return () => { observer.disconnect(); app.removeEventListener('click', feedback); media.removeEventListener('change', scan); loops.forEach(tween => tween.kill()); gsap.killTweensOf(app.querySelectorAll('*')); };
}

export function appear(element) {
  if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  gsap.fromTo(element, { opacity: 0, y: 36, scale: .9, rotationY: -80, transformPerspective: 1100 }, { opacity: 1, y: 0, scale: 1, rotationY: 0, duration: .65, ease: 'back.out(1.2)', clearProps: 'transform,opacity' });
}

export async function disappear(element) {
  if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  gsap.killTweensOf(element);
  await gsap.to(element, { opacity: 0, y: 24, scale: .94, rotationX: 8, duration: .22, ease: 'power2.in' });
  gsap.set(element, { clearProps: 'transform,opacity' });
}

export async function slideQuestion(element, direction, change) {
  if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) { await change(); return; }
  await gsap.to(element, { x: -direction * 65, opacity: 0, duration: .18, ease: 'power2.in' });
  await change();
  if (!element.isConnected) return;
  await gsap.fromTo(element, { x: direction * 65, opacity: 0, rotationY: direction * 5, transformPerspective: 1000 }, { x: 0, opacity: 1, rotationY: 0, duration: .38, ease: 'power3.out', clearProps: 'transform,opacity' });
}
