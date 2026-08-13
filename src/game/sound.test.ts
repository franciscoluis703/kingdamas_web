import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

describe("volumen de la música de fondo", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("controla una ganancia Web Audio y conserva el valor elegido", async () => {
    const setValueAtTime = vi.fn();
    const gain = {
      gain: {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime,
      },
      connect: vi.fn(),
    };
    const source = { connect: vi.fn() };
    class FakeAudioContext {
      state = "running";
      currentTime = 4;
      destination = {};
      createMediaElementSource = vi.fn(() => source);
      createGain = vi.fn(() => gain);
      resume = vi.fn(async () => {});
    }
    class FakeAudio {
      loop = false;
      preload = "";
      volume = 1;
      play = vi.fn(async () => {});
      pause = vi.fn();
      currentTime = 0;
    }
    const documentStub = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      setTimeout,
    });
    vi.stubGlobal("document", documentStub);

    const sound = await import("./sound");
    sound.startBackgroundSound();
    await Promise.resolve();
    sound.setBackgroundVolume(0.35);

    expect(setValueAtTime).toHaveBeenCalledWith(0.35, 4);
    expect(sound.soundPreferences().backgroundVolume).toBe(0.35);
  });

  it("usa el volumen del elemento cuando Web Audio no está disponible", async () => {
    const audioInstances: Array<{ volume: number }> = [];
    class FakeAudio {
      loop = false;
      preload = "";
      volume = 1;
      currentTime = 0;
      play = vi.fn(async () => {});
      pause = vi.fn();

      constructor() {
        audioInstances.push(this);
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const sound = await import("./sound");
    sound.startBackgroundSound();
    await Promise.resolve();
    sound.setBackgroundVolume(0.15);

    expect(audioInstances[0]?.volume).toBe(0.15);
    expect(sound.soundPreferences().backgroundVolume).toBe(0.15);
  });

  it("aplica ganancia compatible a movimientos y capturas", async () => {
    vi.useFakeTimers();
    const gainValues: number[] = [];
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
      createGain = vi.fn(() => {
        const gain = {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
        };
        gainValues.push(gain.value);
        return {
          gain: new Proxy(gain, {
            set(target, property, value) {
              Reflect.set(target, property, value);
              if (property === "value") gainValues[gainValues.length - 1] = Number(value);
              return true;
            },
          }),
          connect: vi.fn(),
        };
      });
      resume = vi.fn(async () => {});
    }
    class FakeAudio {
      loop = false;
      preload = "";
      volume = 1;
      currentTime = 0;
      play = vi.fn(async () => {});
      pause = vi.fn();
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      setTimeout,
    });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const sound = await import("./sound");
    sound.playMoveSound();
    sound.playCaptureSound();
    await vi.runAllTimersAsync();

    expect(gainValues).toContain(0.1);
    expect(gainValues).toContain(0.45);
    vi.useRealTimers();
  });
});
