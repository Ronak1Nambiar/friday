// Whose FRIDAY this is: the name the agents hear in prompts ("<name>'s request, in
// their words"). From profile.user.name, asked in `friday setup`; "the user" until it is set.
let name = '';

export function setUserName(n) { name = String(n || '').trim(); }
export const userName = () => name || 'the user';
export const userPossessive = () => (name ? `${name}'s` : "the user's");
// For the start of a sentence: "The user's request".
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
