/**
 * A script written as the runner expects when it owns the session.
 *
 * Exists for the unit suite: the runner decides whether to create a video itself by checking
 * whether a script exports a function, and that decision needs a fixture on each side of it. This
 * is the "exports a function" side.
 *
 * It is never rendered. Exporting a default function means the runner supplies the API, so nothing
 * here should run if it ever were.
 */

export default async (video: { open(url: string): Promise<void> }): Promise<void> => {
  await video.open('http://localhost:3000/dashboard');
};
