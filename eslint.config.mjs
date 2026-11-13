import smNoSaccadeStyle from 'sm-no-saccade-style';

export default [
	{
		ignores: [
			'.cache/**'
			, 'docs/**'

			// Where SMGen writes a build before it replaces docs/, while a watcher is building.
			, '.docs.smgen-build.*/**'
			, 'site/static/assets/**'
			, 'node_modules/**'
			, 'playwright-report/**'
			, 'runtime-bundle/**'
			, 'test-results/**'
		]
	}
	, ...smNoSaccadeStyle.configs.recommended
];
