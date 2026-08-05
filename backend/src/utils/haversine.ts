/**
 * Haversine distance between two GPS coordinates in meters.
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Midpoint between two GPS coordinates.
 */
export function midpoint(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { lat: number; lon: number } {
  return {
    lat: (lat1 + lat2) / 2,
    lon: (lon1 + lon2) / 2,
  };
}
