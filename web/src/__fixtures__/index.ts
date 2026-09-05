import cpuThreads from "./cpu_threads.rvtrace?raw";
import mutex from "./mutex.rvtrace?raw";
import sleep from "./sleep.rvtrace?raw";
import sleepRuby32 from "./sleep_ruby32.rvtrace?raw";

export const FIXTURES = {
  cpu_threads: cpuThreads,
  sleep,
  mutex,
  sleep_ruby32: sleepRuby32,
} as const;

export type FixtureName = keyof typeof FIXTURES;
