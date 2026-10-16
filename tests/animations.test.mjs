import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileOrLowEndDevice, shouldEnableMotion } from '../client/src/motion.js';

function setMockEnvironment({ navigatorVal, windowVal }) {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWinDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');

  if (navigatorVal !== undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: navigatorVal,
      configurable: true,
      writable: true,
    });
  }

  if (windowVal !== undefined) {
    Object.defineProperty(globalThis, 'window', {
      value: windowVal,
      configurable: true,
      writable: true,
    });
  }

  return () => {
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    } else {
      delete globalThis.navigator;
    }
    if (originalWinDesc) {
      Object.defineProperty(globalThis, 'window', originalWinDesc);
    } else {
      delete globalThis.window;
    }
  };
}

test('device detection identifies mobile, touch, and low-spec environments', () => {
  // 1. Mobile User Agent (Android)
  let restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36',
    },
    windowVal: {
      innerWidth: 412,
      matchMedia: () => ({ matches: false }),
    },
  });
  try {
    assert.equal(isMobileOrLowEndDevice(), true, 'Android user agent should be detected as mobile');
  } finally {
    restore();
  }

  // 2. iOS Safari
  restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    },
    windowVal: {
      innerWidth: 390,
      matchMedia: () => ({ matches: false }),
    },
  });
  try {
    assert.equal(isMobileOrLowEndDevice(), true, 'iPhone user agent should be detected as mobile');
  } finally {
    restore();
  }

  // 3. UserAgentData mobile flag
  restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Custom Browser',
      userAgentData: { mobile: true },
    },
    windowVal: {
      innerWidth: 800,
      matchMedia: () => ({ matches: false }),
    },
  });
  try {
    assert.equal(isMobileOrLowEndDevice(), true, 'userAgentData.mobile should be detected as mobile');
  } finally {
    restore();
  }

  // 4. Touch device with compact/medium screen
  restore = setMockEnvironment({
    navigatorVal: { userAgent: 'Generic Desktop-like Browser' },
    windowVal: {
      innerWidth: 768,
      matchMedia: (query) => ({ matches: query.includes('pointer: coarse') }),
    },
  });
  try {
    assert.equal(isMobileOrLowEndDevice(), true, 'Touch device on tablet screen should be detected as low-end/touch');
  } finally {
    restore();
  }

  // 5. Low-end desktop (4 cores or less)
  restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hardwareConcurrency: 2,
    },
    windowVal: {
      innerWidth: 1920,
      matchMedia: () => ({ matches: false }),
    },
  });
  try {
    assert.equal(isMobileOrLowEndDevice(), true, 'Desktop with <= 4 cores should trigger low-end optimization');
  } finally {
    restore();
  }

  // 6. Powerful Desktop
  restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hardwareConcurrency: 8,
      deviceMemory: 16,
    },
    windowVal: {
      innerWidth: 1920,
      matchMedia: () => ({ matches: false }),
    },
  });
  try {
    assert.equal(isMobileOrLowEndDevice(), false, 'Powerful desktop should not be detected as mobile/low-end');
  } finally {
    restore();
  }
});

test('shouldEnableMotion correctly respects global and auto-device settings', () => {
  // Desktop environment
  let restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hardwareConcurrency: 12,
      deviceMemory: 32,
    },
    windowVal: {
      innerWidth: 1920,
      matchMedia: () => ({ matches: false }),
    },
  });

  try {
    // Default settings (animations enabled, auto-device enabled) on desktop
    assert.equal(shouldEnableMotion({ enable_animations: '1', auto_device_animations: '1' }), true);

    // Global toggle disabled -> off everywhere
    assert.equal(shouldEnableMotion({ enable_animations: '0', auto_device_animations: '1' }), false);
    assert.equal(shouldEnableMotion({ enable_animations: '0', auto_device_animations: '0' }), false);
  } finally {
    restore();
  }

  // Reduced motion media query in OS -> off even if enabled
  restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      hardwareConcurrency: 12,
      deviceMemory: 32,
    },
    windowVal: {
      innerWidth: 1920,
      matchMedia: (query) => ({ matches: query.includes('prefers-reduced-motion') }),
    },
  });
  try {
    assert.equal(shouldEnableMotion({ enable_animations: '1', auto_device_animations: '0' }), false);
  } finally {
    restore();
  }

  // Mobile environment
  restore = setMockEnvironment({
    navigatorVal: {
      userAgent: 'Mozilla/5.0 (Linux; Android 12; SM-A125F)',
      hardwareConcurrency: 4,
    },
    windowVal: {
      innerWidth: 360,
      matchMedia: () => ({ matches: false }),
    },
  });
  try {
    // Auto device is ON -> mobile has animations OFF
    assert.equal(shouldEnableMotion({ enable_animations: '1', auto_device_animations: '1' }), false);

    // Auto device is OFF -> admin forced animations ON even on mobile
    assert.equal(shouldEnableMotion({ enable_animations: '1', auto_device_animations: '0' }), true);
  } finally {
    restore();
  }
});
