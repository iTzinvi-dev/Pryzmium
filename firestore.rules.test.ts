import fs from 'fs';

const rules = fs.readFileSync('firestore.rules', 'utf8');

function verifyDirtyDozenAssertions() {
  const assertions = [
    {
      name: '1. Default deny catch-all exists',
      pass: rules.includes('match /{document=**}') && rules.includes('allow read, write: if false;')
    },
    {
      name: '2. Email verification enforced on owner helper',
      pass: rules.includes('request.auth.token.email_verified == true')
    },
    {
      name: '3. Connections vault strictly blocks client read and write',
      pass: rules.includes('match /connections/{providerId}') && rules.includes('allow read, write: if false;')
    },
    {
      name: '4. UserProfile enforces strict keys and free plan on create',
      pass: rules.includes("incoming().plan == 'free'")
    },
    {
      name: '5. Temporal integrity enforced via request.time',
      pass: rules.includes('incoming().createdAt == request.time') && rules.includes('incoming().updatedAt == request.time')
    },
    {
      name: '6. PendingAction locks terminal states',
      pass: rules.includes("existing().status == 'pending'")
    },
    {
      name: '7. AuditLog forbids updates',
      pass: rules.includes('match /auditLog/{logId}') && rules.includes('allow update: if false;')
    },
    {
      name: '8. Secure list queries check resource.data.uid',
      pass: rules.includes('allow list: if isVerifiedOwner(userId)\n          && existing().uid == request.auth.uid;')
    }
  ];

  for (const a of assertions) {
    if (!a.pass) {
      throw new Error(`Security assertion failed: ${a.name}`);
    }
  }
}

verifyDirtyDozenAssertions();
