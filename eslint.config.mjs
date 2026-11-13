import smNoSaccadeStyle from 'sm-no-saccade-style';

export default [
	{
		ignores: [
			'.cache/**'
			, 'docs/**'
			, 'site/static/assets/**'
			, 'node_modules/**'
			, 'playwright-report/**'
			, 'runtime-bundle/**'
			, 'test-results/**'
		]
	}
	, ...smNoSaccadeStyle.configs.recommended
];
