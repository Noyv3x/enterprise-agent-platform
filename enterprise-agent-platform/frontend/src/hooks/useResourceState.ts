import { IDLE_RESOURCE_STATE } from "../data/resourceState";
import { useStore } from "../store/useStore";

export function useResourceState(key: string) {
  return useStore((state) => state.resourceStates[key] || IDLE_RESOURCE_STATE);
}
