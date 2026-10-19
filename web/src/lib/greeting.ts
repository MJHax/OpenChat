/** The Chat home's greeting for a local hour (0–23). */
export function greeting(hour: number): 'Good morning.' | 'Good afternoon.' | 'Good evening.' {
  if (hour >= 5 && hour <= 11) return 'Good morning.';
  if (hour >= 12 && hour <= 17) return 'Good afternoon.';
  return 'Good evening.';
}
