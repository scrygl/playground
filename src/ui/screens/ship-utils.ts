import { SHIPS, SHIPS_BY_ID, type ShipDefinition } from '../../game/ships';

/**
 * `getShip` throws on an unknown id, which is right for the simulation and
 * wrong for the interface: a stale selection in a saved profile should show the
 * starter craft, not blank the garage.
 */
export function getShipSafe(id: string): ShipDefinition {
  return SHIPS_BY_ID.get(id) ?? SHIPS[0];
}
