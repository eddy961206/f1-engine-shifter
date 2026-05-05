import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  View
} from 'react-native';
import { useEngineAudio } from './src/audio/useEngineAudio';
import { MAX_RPM, MIN_RPM, createInitialEngineState, shiftGear, stepEngine } from './src/engine/simulation';

const TICK_MS = 50;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatRpm(rpm) {
  return Math.round(rpm).toLocaleString('en-US');
}

function Tachometer({ rpm, throttle, gear }) {
  const rpmNorm = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
  const redline = rpm > 10250;
  const bars = useMemo(() => Array.from({ length: 24 }, (_, index) => index), []);

  return (
    <View style={styles.tach}>
      <View style={styles.tachHeader}>
        <View>
          <Text style={styles.microLabel}>RPM</Text>
          <Text style={[styles.rpmText, redline && styles.redlineText]}>{formatRpm(rpm)}</Text>
        </View>
        <View style={styles.gearBox}>
          <Text style={styles.microLabelDark}>GEAR</Text>
          <Text style={styles.gearText}>{gear}</Text>
        </View>
      </View>

      <View style={styles.barRail}>
        {bars.map((index) => {
          const active = index / bars.length <= rpmNorm;
          const danger = index > 19;
          return (
            <View
              key={index}
              style={[
                styles.rpmBar,
                active && styles.rpmBarActive,
                active && danger && styles.rpmBarDanger
              ]}
            />
          );
        })}
      </View>

      <View style={styles.throttleTrack}>
        <View style={[styles.throttleFill, { width: `${Math.round(throttle * 100)}%` }]} />
      </View>
    </View>
  );
}

function ControlButton({ label, value, onPress, onPressIn }) {
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}
    >
      <Text style={styles.controlValue}>{value}</Text>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [engine, setEngine] = useState(() => createInitialEngineState());
  const [running, setRunning] = useState(false);
  const [autoShift, setAutoShift] = useState(false);
  const [volume, setVolume] = useState(0.82);
  const [throttleHeld, setThrottleHeld] = useState(false);
  const [brakeHeld, setBrakeHeld] = useState(false);
  const [shiftEvent, setShiftEvent] = useState(null);
  const inputRef = useRef({ throttleHeld: false, brakeHeld: false, running: false, autoShift: false });
  const shiftSeqRef = useRef(0);
  const lastTickAtRef = useRef(Date.now());

  inputRef.current = { throttleHeld, brakeHeld, running, autoShift };

  const createShiftEvent = useCallback((direction, gear, current, nextThrottle) => {
    shiftSeqRef.current += 1;
    return {
      id: shiftSeqRef.current,
      direction,
      gear,
      fromGear: current.gear,
      rpmBefore: Math.round(current.rpm),
      throttle: nextThrottle
    };
  }, []);

  useEngineAudio({
    enabled: running,
    rpm: engine.rpm,
    rpmVel: engine.rpmVel,
    gear: engine.gear,
    throttle: engine.throttle,
    throttleHeld,
    brakeHeld,
    volume,
    shiftEvent
  });

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const dt = clamp((now - lastTickAtRef.current) / 1000, 0.012, 0.09);
      lastTickAtRef.current = now;

      setEngine((current) => {
        const next = stepEngine(current, inputRef.current, dt);
        if (next.shift) {
          setShiftEvent({
            ...createShiftEvent(next.shift, next.gear, current, next.throttle),
            rpmAfter: Math.round(next.rpm),
          });
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [createShiftEvent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      lastTickAtRef.current = Date.now();
      if (state === 'active') return;
      setThrottleHeld(false);
      setBrakeHeld(false);
      setRunning(false);
    });

    return () => subscription.remove();
  }, []);

  const requestShift = useCallback((direction) => {
    setEngine((current) => {
      const shifted = shiftGear(current, direction);
      if (shifted.shift) {
        setShiftEvent({
          ...createShiftEvent(direction, shifted.gear, current, current.throttle),
          rpmAfter: Math.round(shifted.rpm),
        });
      }
      return shifted;
    });
  }, [createShiftEvent]);

  const bumpVolume = useCallback((delta) => {
    setVolume((current) => clamp(Number((current + delta).toFixed(2)), 0, 1));
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View>
            <Text style={styles.appKicker}>V10 TOUCH SIM</Text>
            <Text style={styles.title}>F1 Engine Shifter</Text>
          </View>
          <Pressable
            onPress={() => setRunning((value) => !value)}
            style={[styles.powerButton, running && styles.powerButtonActive]}
          >
            <Text style={styles.powerIcon}>{running ? 'STOP' : 'START'}</Text>
          </Pressable>
        </View>

        <Tachometer rpm={engine.rpm} throttle={engine.throttle} gear={engine.gear} />

        <View style={styles.paddleRow}>
          <ControlButton label="GEAR DOWN" value="-" onPressIn={() => requestShift('DOWN')} />
          <ControlButton label="GEAR UP" value="+" onPressIn={() => requestShift('UP')} />
        </View>

        <View style={styles.driveRow}>
          <Pressable
            onPressIn={() => setBrakeHeld(true)}
            onPressOut={() => setBrakeHeld(false)}
            style={({ pressed }) => [styles.pedal, styles.brakePedal, pressed && styles.pedalPressed]}
          >
            <Text style={styles.brakeText}>BRAKE</Text>
            <Text style={styles.pedalHint}>hold</Text>
          </Pressable>
          <Pressable
            onPressIn={() => setThrottleHeld(true)}
            onPressOut={() => setThrottleHeld(false)}
            style={({ pressed }) => [styles.pedal, styles.throttlePedal, pressed && styles.pedalPressed]}
          >
            <Text style={styles.throttleText}>REV</Text>
            <Text style={styles.throttleHint}>hold</Text>
          </Pressable>
        </View>

        <View style={styles.tunePanel}>
          <View style={styles.tuneLine}>
            <Text style={styles.tuneLabel}>AUTO SHIFT</Text>
            <Switch
              value={autoShift}
              onValueChange={setAutoShift}
              trackColor={{ false: '#353535', true: '#d8ff5f' }}
              thumbColor={autoShift ? '#111111' : '#f4f0e8'}
            />
          </View>
          <View style={styles.volumeRow}>
            <ControlButton label="VOLUME" value="-" onPress={() => bumpVolume(-0.08)} />
            <View style={styles.volumeReadout}>
              <Text style={styles.microLabel}>MASTER</Text>
              <Text style={styles.volumeText}>{Math.round(volume * 100)}%</Text>
            </View>
            <ControlButton label="VOLUME" value="+" onPress={() => bumpVolume(0.08)} />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0f0f0d'
  },
  shell: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    gap: 18
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 76
  },
  appKicker: {
    color: '#d8ff5f',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0
  },
  title: {
    color: '#f4f0e8',
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 0,
    marginTop: 3
  },
  powerButton: {
    width: 86,
    height: 54,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2a26',
    borderWidth: 1,
    borderColor: '#46463f'
  },
  powerButtonActive: {
    backgroundColor: '#b91616',
    borderColor: '#ff5c43'
  },
  powerIcon: {
    color: '#f4f0e8',
    fontSize: 15,
    fontWeight: '900'
  },
  tach: {
    backgroundColor: '#171714',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#30302a',
    padding: 18,
    gap: 18
  },
  tachHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  },
  microLabel: {
    color: '#aaa69c',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0
  },
  microLabelDark: {
    color: '#333333',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0
  },
  rpmText: {
    color: '#f4f0e8',
    fontSize: 54,
    fontWeight: '900',
    letterSpacing: 0,
    marginTop: 2
  },
  redlineText: {
    color: '#ff3f2f'
  },
  gearBox: {
    width: 82,
    height: 82,
    borderRadius: 8,
    backgroundColor: '#f4f0e8',
    alignItems: 'center',
    justifyContent: 'center'
  },
  gearText: {
    color: '#111111',
    fontSize: 44,
    fontWeight: '900',
    lineHeight: 48
  },
  barRail: {
    flexDirection: 'row',
    gap: 4,
    minHeight: 74,
    alignItems: 'flex-end'
  },
  rpmBar: {
    flex: 1,
    height: 28,
    borderRadius: 3,
    backgroundColor: '#302f2a'
  },
  rpmBarActive: {
    height: 68,
    backgroundColor: '#d8ff5f'
  },
  rpmBarDanger: {
    backgroundColor: '#ff3f2f'
  },
  throttleTrack: {
    height: 14,
    borderRadius: 3,
    backgroundColor: '#30302a',
    overflow: 'hidden'
  },
  throttleFill: {
    height: '100%',
    backgroundColor: '#f2cb05'
  },
  paddleRow: {
    flexDirection: 'row',
    gap: 12
  },
  controlButton: {
    flex: 1,
    height: 78,
    borderRadius: 8,
    backgroundColor: '#252520',
    borderWidth: 1,
    borderColor: '#3d3d36',
    alignItems: 'center',
    justifyContent: 'center'
  },
  controlButtonPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.82
  },
  controlValue: {
    color: '#f4f0e8',
    fontSize: 32,
    fontWeight: '900',
    lineHeight: 36
  },
  controlLabel: {
    color: '#aaa69c',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 4
  },
  driveRow: {
    flexDirection: 'row',
    gap: 14,
    flex: 1
  },
  pedal: {
    flex: 1,
    minHeight: 170,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1
  },
  brakePedal: {
    backgroundColor: '#261817',
    borderColor: '#6d2b24'
  },
  throttlePedal: {
    backgroundColor: '#d8ff5f',
    borderColor: '#eaff95'
  },
  pedalPressed: {
    transform: [{ scale: 0.985 }],
    opacity: 0.9
  },
  brakeText: {
    color: '#f4f0e8',
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 0
  },
  throttleText: {
    color: '#111111',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 0
  },
  pedalHint: {
    color: '#aaa69c',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 6
  },
  throttleHint: {
    color: '#4d4d35',
    fontSize: 12,
    fontWeight: '900',
    marginTop: 6
  },
  tunePanel: {
    gap: 14
  },
  tuneLine: {
    height: 54,
    borderRadius: 8,
    backgroundColor: '#171714',
    borderWidth: 1,
    borderColor: '#30302a',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  tuneLabel: {
    color: '#f4f0e8',
    fontSize: 14,
    fontWeight: '900'
  },
  volumeRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center'
  },
  volumeReadout: {
    width: 102,
    height: 78,
    borderRadius: 8,
    backgroundColor: '#171714',
    borderWidth: 1,
    borderColor: '#30302a',
    alignItems: 'center',
    justifyContent: 'center'
  },
  volumeText: {
    color: '#f4f0e8',
    fontSize: 22,
    fontWeight: '900',
    marginTop: 3
  }
});
