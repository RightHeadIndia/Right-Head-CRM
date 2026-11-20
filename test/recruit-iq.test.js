'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanRequirements, verifyMatch, scoreCategory, DEFAULT_WEIGHTS } = require('../lib/recruit-iq');

test('RecruitIQ accepts default weights and rejects a custom total other than 100', () => {
  const requirements = cleanRequirements({});
  assert.deepEqual(requirements.weights, DEFAULT_WEIGHTS);
  assert.throws(() => cleanRequirements({ weights: { ...DEFAULT_WEIGHTS, Skills: 29 } }), /add up to 100/);
});

test('RecruitIQ computes weighted totals itself and flags mandatory requirements without CV evidence', () => {
  const requirements = cleanRequirements({ mandatory: ['Security clearance'] });
  const result = verifyMatch({
    profile: { name: 'Asha Sharma', email: 'asha@example.com', phone: '', skills: ['Node.js', 'Invented skill'] },
    matching: {
      dimensions: [
        { name: 'Skills', score: 100 }, { name: 'Relevant experience', score: 80 },
        { name: 'Industry experience', score: 60 }, { name: 'Role and responsibilities', score: 40 },
        { name: 'Education', score: 20 }, { name: 'Tools and certifications', score: 0 }
      ],
      matchedSkills: ['Node.js', 'Invented skill'], missingSkills: [],
      mandatoryRequirements: [{ requirement: 'Security clearance', met: true, evidence: 'Security clearance approved' }]
    }
  }, requirements, 'Asha Sharma has experience building Node.js applications. Her email is asha@example.com.', 'The role requires Node.js and a security clearance.');

  assert.equal(result.matching.total, 63);
  assert.equal(result.matching.category, 'Moderate Match');
  assert.deepEqual(result.matching.matchedSkills, ['Node.js']);
  assert.deepEqual(result.matching.missingSkills, []);
  assert.equal(result.profile.name, 'Asha Sharma');
  assert.equal(result.matching.mandatoryMet, false);
  assert.equal(result.matching.mandatoryRequirements[0].met, false);
});

test('RecruitIQ category boundaries match the published ranges', () => {
  assert.equal(scoreCategory(85), 'Excellent Match');
  assert.equal(scoreCategory(70), 'Good Match');
  assert.equal(scoreCategory(55), 'Moderate Match');
  assert.equal(scoreCategory(54), 'Low Match');
});
