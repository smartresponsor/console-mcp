export type WebWorkerAdmissionSnapshot = {
  state: "ACTIVE" | "DRAINING" | "DRAINED";
  activeOperations: number;
};

export function createWebWorkerAdmissionGate() {
  let draining = false;
  let activeOperations = 0;
  const snapshot = (): WebWorkerAdmissionSnapshot => ({
    state: !draining ? "ACTIVE" : activeOperations === 0 ? "DRAINED" : "DRAINING",
    activeOperations,
  });
  return {
    snapshot,
    begin(): (() => void) | null {
      if (draining) return null;
      activeOperations += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeOperations -= 1;
      };
    },
    drain(): WebWorkerAdmissionSnapshot {
      draining = true;
      return snapshot();
    },
    resume(): WebWorkerAdmissionSnapshot {
      draining = false;
      return snapshot();
    },
  };
}
