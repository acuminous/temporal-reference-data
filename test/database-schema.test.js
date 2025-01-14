const { ok, strictEqual: eq, deepEqual: deq, rejects, match } = require('node:assert');
const { scheduler } = require('node:timers/promises');
const { describe, it, before, beforeEach, after, afterEach } = require('zunit');
const { PostgresError: { UNIQUE_VIOLATION, NOT_NULL_VIOLATION, FOREIGN_KEY_VIOLATION } } = require('pg-error-enum');

const TestFilby = require('./TestFilby');

const config = {
  database: {
    user: 'fby_test',
    password: 'fby_test',
  },
  notifications: {
    initialDelay: '0ms',
    interval: '100ms',
    maxAttempts: 3,
    maxRescheduleDelay: '100ms',
  },
};

describe('Database Schema', () => {

  let filby;

  before(async () => {
    filby = new TestFilby(config);
    await filby.reset();
  });

  beforeEach(async () => {
    await filby.wipe();
  });

  after(async () => {
    await filby.stop();
  });

  describe('Projections', () => {
    it('should prevent duplicate projections', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO fby_projection (name, version) VALUES
          ('NOT DUPLICATE', 1),
          ('NOT DUPLICATE', 2),
          ('NOT DUPLICATE A', 1),
          ('NOT DUPLICATE B', 1)
        `);
      });

      await rejects(async () => {
        await filby.withTransaction(async (tx) => {
          await tx.query(`INSERT INTO fby_projection (name, version) VALUES
            ('DUPLICATE', 1),
            ('DUPLICATE', 1)
          `);
        });
      }, (err) => {
        eq(err.code, UNIQUE_VIOLATION);
        return true;
      });
    });

    it('should enforce projections are named', async () => {
      await rejects(async () => {
        await filby.withTransaction(async (tx) => {
          await tx.query('INSERT INTO fby_projection (name, version) VALUES (NULL, 1)');
        });
      }, (err) => {
        eq(err.code, NOT_NULL_VIOLATION);
        return true;
      });
    });

    it('should enforce projections are versioned', async () => {
      await rejects(async () => {
        await filby.withTransaction(async (tx) => {
          await tx.query("INSERT INTO fby_projection (name, version) VALUES ('OK', NULL)");
        });
      }, (err) => {
        eq(err.code, NOT_NULL_VIOLATION);
        return true;
      });
    });

    it('should dereference dependencies when deleted', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query("INSERT INTO fby_projection (id, name, version) VALUES (1, 'Parks', 1)");
        await tx.query("INSERT INTO fby_entity (id, name, version) VALUES (1, 'Park', 1)");
        await tx.query('INSERT INTO fby_projection_entity (projection_id, entity_id) VALUES (1, 1)');
        await tx.query('DELETE FROM fby_projection');
      });

      const { rows: dependencies } = await filby.withTransaction((tx) => tx.query('SELECT * from fby_projection_entity'));
      eq(dependencies.length, 0);
    });
  });

  describe('Entities', () => {

    it('should prevent deletion when there are dependent projections', async () => {
      await rejects(() => filby.withTransaction(async (tx) => {
        await tx.query("INSERT INTO fby_projection (id, name, version) VALUES (1, 'Parks', 1)");
        await tx.query("INSERT INTO fby_entity (id, name, version) VALUES (1, 'Park', 1)");
        await tx.query('INSERT INTO fby_projection_entity (projection_id, entity_id) VALUES (1, 1)');
        await tx.query('DELETE FROM fby_entity');
      }), (err) => {
        eq(err.code, FOREIGN_KEY_VIOLATION);
        return true;
      });
    });

    it('should NOT cascade deletes to data frames', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query("INSERT INTO fby_entity (id, name, version) VALUES (1, 'Park', 1)");
        await tx.query("INSERT INTO fby_change_set (id, description, effective) VALUES (1, 'Park updates',now())");
        await tx.query("INSERT INTO fby_data_frame (id, change_set_id, entity_id, action) VALUES (1, 1, 1, 'POST')");
      });

      await rejects(() => filby.withTransaction((tx) => tx.query('DELETE FROM fby_entity')), (err) => {
        eq(err.code, FOREIGN_KEY_VIOLATION);
        return true;
      });
    });
  });

  describe('Hooks', () => {
    it('should prevent duplicate projection hooks', async () => {

      await filby.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO fby_projection (id, name, version) VALUES
          (1, 'Park', 1),
          (2, 'Park', 2)
        `);

        await tx.query(`INSERT INTO fby_hook (name, event, projection_id) VALUES
          ('change 1', 'ADD_CHANGE_SET', 1),
          ('change 2', 'ADD_CHANGE_SET', 2),
          ('change 3', 'ADD_CHANGE_SET', NULL)
        `);
      });

      await rejects(async () => {
        await filby.withTransaction(async (tx) => {
          await tx.query("INSERT INTO fby_hook (name, event, projection_id) VALUES ('change 1', 'ADD_CHANGE_SET', 1)");
        });
      }, (err) => {
        eq(err.code, UNIQUE_VIOLATION);
        return true;
      });
    });

    it('should cascade deletes from projection', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query("INSERT INTO fby_projection (id, name, version) VALUES (1, 'Park', 1)");
        await tx.query("INSERT INTO fby_hook (name, event, projection_id) VALUES ('change', 'ADD_CHANGE_SET', 1)");
        await tx.query('DELETE FROM fby_projection');
      });

      const { rows: hooks } = await filby.withTransaction((tx) => tx.query('SELECT * from fby_hook'));
      eq(hooks.length, 0);
    });
  });

  describe('Notifications', () => {
    it('should cascade deletes from projection via hook', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query("INSERT INTO fby_projection (id, name, version) VALUES (1, 'Park', 1)");
        await tx.query("INSERT INTO fby_hook (id, name, event, projection_id) VALUES (1, 'change', 'ADD_CHANGE_SET', 1)");
        await tx.query("INSERT INTO fby_notification (id, hook_id, projection_name, projection_version) VALUES (1, 1, 'Park', 1)");
        await tx.query('DELETE FROM fby_projection');
      });

      const { rows: notifications } = await filby.withTransaction((tx) => tx.query('SELECT * from fby_notification'));
      eq(notifications.length, 0);
    });

    it('should cascade deletes from hook', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query("INSERT INTO fby_projection (id, name, version) VALUES (1, 'Park', 1)");
        await tx.query("INSERT INTO fby_hook (id, name, event, projection_id) VALUES (1, 'change', 'ADD_CHANGE_SET', 1)");
        await tx.query("INSERT INTO fby_notification (id, hook_id, projection_name, projection_version) VALUES (1, 1, 'Park', 1)");
        await tx.query('DELETE FROM fby_hook');
      });

      const { rows: notifications } = await filby.withTransaction((tx) => tx.query('SELECT * from fby_notification'));
      eq(notifications.length, 0);
    });
  });

  describe('Change Sets', () => {
    it('should prevent duplicate change sets', async () => {

      await filby.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO fby_change_set (id, description, effective) VALUES
          (1, 'Park updates', '2023-01-01T00:00:00.000Z'),
          (2, 'Park updates', '2023-01-01T00:00:00.000Z')
        `);
      });

      await rejects(async () => {
        await filby.withTransaction(async (tx) => {
          await tx.query(`INSERT INTO fby_change_set (id, description, effective) VALUES
            (3, 'Park updates', '2023-01-01T00:00:00.000Z'),
            (3, 'Park updates', '2023-01-01T00:00:00.000Z')`);
        });
      }, (err) => {
        eq(err.code, UNIQUE_VIOLATION);
        return true;
      });
    });

    it('should enforce change sets have effective dates', async () => {
      await rejects(async () => {
        await filby.withTransaction(async (tx) => {
          await tx.query("INSERT INTO fby_change_set (id, description, effective) VALUES (1, 'Park updates', NULL)");
        });
      }, (err) => {
        eq(err.code, NOT_NULL_VIOLATION);
        return true;
      });
    });

    it('should default last modified date to now', async () => {
      const checkpoint = new Date();

      await scheduler.wait(1);

      await filby.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO fby_change_set (id, description, effective) VALUES
          (1, 'Countries', '2020-04-05T00:00:00.000Z')`);
      });

      const changeSet = await filby.getChangeSet(1);
      ok(changeSet.lastModified >= checkpoint, `${changeSet.lastModified.getTime()} was less than ${checkpoint.getTime()}`);
    });

    it('should default entity tag to random hex', async () => {
      await filby.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO fby_change_set (id, description, effective) VALUES
          (1, 'Countries', '2020-04-05T00:00:00.000Z')`);
      });

      const changeSet = await filby.getChangeSet(1);
      match(changeSet.entityTag, /^[a-f|0-9]{20}$/);
    });
  });
});
