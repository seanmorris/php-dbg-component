// Follow the visitor's colour scheme and let a header button override it.
//
// Load this file as a blocking head script (SCRIPTS). With nothing stored the
// page follows prefers-color-scheme, including live changes. A click on any
// element with data-theme-toggle switches the theme and remembers the choice.

(function() {
	const root = document.documentElement;
	const storageKey = 'theme';
	const media = matchMedia('(prefers-color-scheme: dark)');

	/**
	 * Read the stored theme without making storage availability mandatory.
	 *
	 * @returns {string|null} "light", "dark", or null when nothing valid is stored.
	 */
	function storedTheme()
	{
		try
		{
			const value = localStorage.getItem(storageKey);

			return value === 'light' || value === 'dark' ? value : null;
		}
		catch(error)
		{
			return null;
		}
	}

	/**
	 * Report the theme the operating system currently prefers.
	 *
	 * @returns {string} "light" or "dark".
	 */
	function systemTheme()
	{
		return media.matches ? 'dark' : 'light';
	}

	/**
	 * Apply a theme to the document and label every toggle for the other one.
	 *
	 * @param {string} theme "light" or "dark".
	 * @returns {void}
	 */
	function apply(theme)
	{
		root.setAttribute('data-theme', theme);
		root.style.colorScheme = theme;

		for(const toggle of document.querySelectorAll('[data-theme-toggle]'))
		{
			toggle.setAttribute(
				'aria-label'
				, theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
			);

			toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
		}
	}

	/**
	 * Switch to the other theme and remember it when storage allows.
	 *
	 * @returns {void}
	 */
	function toggle()
	{
		const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
		apply(next);

		try
		{
			localStorage.setItem(storageKey, next);
		}
		catch(error)
		{
			// Storage may be unavailable; the choice still applies to this page.
		}
	}

	apply(storedTheme() || systemTheme());

	media.addEventListener('change', function() {
		if(storedTheme() === null) apply(systemTheme());
	});

	document.addEventListener('DOMContentLoaded', function() {
		apply(root.getAttribute('data-theme') || systemTheme());
	});

	document.addEventListener('click', function(event) {
		const target = event.target instanceof Element
			? event.target.closest('[data-theme-toggle]')
			: null;

		if(!target) return;

		event.preventDefault();
		toggle();
	});
})();
