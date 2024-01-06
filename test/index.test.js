const { ok, strictEqual: eq, deepEqual: deq, rejects, match } = require('node:assert');
const { describe, it, before, after, beforeEach } = require('zunit');

const ReferenceDataFramework = require('..');

const config = {
  migrations: 'test/migrations',
  database: {
    user: 'rdf_test',
    password: 'rdf_test'
  }
}

describe('RDF', () => {

  let rdf;

  before(async () => {
    rdf = new TestReferenceDataFramework(config);
    await rdf.init();
  })

  beforeEach(async () => {
    await rdf.wipe();
  })

  after(async () => {
    await rdf.stop();
  })

  describe('Projections', () => {
    it('should prevent duplicate projections', async () => {

      await rdf.withTransaction(async (tx) => {
        await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('NOT DUPLICATE', 1)");
        await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('NOT DUPLICATE', 2)");

        await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('NOT DUPLICATE A', 1)");
        await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('NOT DUPLICATE B', 1)");
      });

      await rejects(async () => {
        await rdf.withTransaction(async (tx) => {
          await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('DUPLICATE', 1)");
          await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('DUPLICATE', 1)");
        });
      }, (err) => {
        eq(err.code, '23505');
        return true;
      })
    });

    it('should enforce projections are named', async () => {
      await rejects(async () => {
        await rdf.withTransaction(async (tx) => {
          await tx.query("INSERT INTO rdf_projection (name, version) VALUES (NULL, 1)");
        });
      }, (err) => {
        eq(err.code, '23502');
        return true;
      })
    });

    it('should enforce projections are versioned', async () => {
      await rejects(async () => {
        await rdf.withTransaction(async (tx) => {
          await tx.query("INSERT INTO rdf_projection (name, version) VALUES ('OK', NULL)");
        });
      }, (err) => {
        eq(err.code, '23502');
        return true;
      })
    });

    it('should list projections', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_projection VALUES
          (1, 'VAT Rates', 1),
          (2, 'VAT Rates', 2),
          (3, 'CGT Rates', 1)`
        );
      });

      const projections = await rdf.getProjections();
      eq(projections.length, 3);
      deq(projections[0], { id: 1, name: 'VAT Rates', version: 1 });
      deq(projections[1], { id: 2, name: 'VAT Rates', version: 2 });
      deq(projections[2], { id: 3, name: 'CGT Rates', version: 1 });
    });

    it('should get projection by name and version', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_projection VALUES
          (1, 'VAT Rates', 1),
          (2, 'VAT Rates', 2),
          (3, 'CGT Rates', 1)`
        );
      });

      const projection = await rdf.getProjection('VAT Rates', 2);
      deq(projection, { id: 2, name: 'VAT Rates', version: 2 });
    });
  });

  describe('Change Sets', () => {
    it('should prevent duplicate change sets', async () => {

      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from) VALUES
          (1, '2023-01-01T00:00:00.000Z'),
          (2, '2023-01-01T00:00:00.000Z')
        `);
      });

      await rejects(async () => {
        await rdf.withTransaction(async (tx) => {
          await tx.query(`INSERT INTO rdf_change_set (id, effective_from) VALUES
            (3, '2023-01-01T00:00:00.000Z'),
            (3, '2023-01-01T00:00:00.000Z')`
          );
        });
      }, (err) => {
        eq(err.code, '23505');
        return true;
      })
    });

    it('should enforce change sets have effective_from dates', async () => {
      await rejects(async () => {
        await rdf.withTransaction(async (tx) => {
          await tx.query("INSERT INTO rdf_change_set (id, effective_from) VALUES (1, NULL)");
        });
      }, (err) => {
        eq(err.code, '23502');
        return true;
      })
    });

    it('should list change sets for the given projection', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_projection (id, name, version) VALUES
          (1, 'VAT Rates', 1),
          (2, 'CGT Rates', 1)`
        );
        await tx.query(`INSERT INTO rdf_entity (id, name, version) VALUES
          (1, 'Country', 1),
          (2, 'VAT Rate', 1),
          (3, 'CGT Rate', 1)
        `);
        await tx.query(`INSERT INTO rdf_projection_entity (projection_id, entity_id) VALUES
          (1, 1),
          (1, 2),
          (2, 1),
          (2, 3)`
        );
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', 'Countries'),
          (2, '2020-04-05T00:00:00.000Z', '2020 VAT Rates'),
          (3, '2020-04-05T00:00:00.000Z', '2020 CGT Rates'),
          (4, '2021-04-05T00:00:00.000Z', '2021 VAT Rates'),
          (5, '2021-04-05T00:00:00.000Z', '2021 CGT Rates')`
        );
        await tx.query(`INSERT INTO rdf_data_frame (change_set_id, entity_id, action) VALUES
          (1, 1, 'POST'),
          (2, 2, 'POST'),
          (3, 3, 'POST'),
          (4, 2, 'POST'),
          (5, 3, 'POST')`
        );
      });

      const projection = await rdf.getProjection('VAT Rates', 1);
      const changelog = (await rdf.getChangeLog(projection)).map(({ id, effectiveFrom, notes }) => ({ id, effectiveFrom: effectiveFrom.toISOString(), notes }));
      eq(changelog.length, 3);
      deq(changelog[0], { id: 1, effectiveFrom: '2020-04-05T00:00:00.000Z', notes: 'Countries' });
      deq(changelog[1], { id: 2, effectiveFrom: '2020-04-05T00:00:00.000Z', notes: '2020 VAT Rates' });
      deq(changelog[2], { id: 4, effectiveFrom: '2021-04-05T00:00:00.000Z', notes: '2021 VAT Rates' });
    });

    it('should dedupe change sets', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_projection (id, name, version) VALUES
          (1, 'VAT Rates', 1)`
        );
        await tx.query(`INSERT INTO rdf_entity (id, name, version) VALUES
          (1, 'Country', 1),
          (2, 'VAT Rate', 1)
        `);
        await tx.query(`INSERT INTO rdf_projection_entity (projection_id, entity_id) VALUES
          (1, 1),
          (1, 2)`
        );
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', 'Everything')`
        );
        await tx.query(`INSERT INTO rdf_data_frame (change_set_id, entity_id, action) VALUES
          (1, 1, 'POST'),
          (1, 2, 'POST'),
          (1, 2, 'POST')`
        );
      });

      const projection = await rdf.getProjection('VAT Rates', 1);
      const changelog = (await rdf.getChangeLog(projection)).map(({ id, effectiveFrom, notes }) => ({ id, effectiveFrom: effectiveFrom.toISOString(), notes }));
      eq(changelog.length, 1);
      deq(changelog[0], { id: 1, effectiveFrom: '2020-04-05T00:00:00.000Z', notes: 'Everything' });
    });

    it('should get change set by id', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', 'Countries'),
          (2, '2020-04-05T00:00:00.000Z', '2020 VAT Rates'),
          (3, '2020-04-05T00:00:00.000Z', '2020 CGT Rates')`
        );
      });

      const changeSet = await rdf.getChangeSet(2);
      eq(changeSet.id, 2);
      eq(changeSet.effectiveFrom.toISOString(), '2020-04-05T00:00:00.000Z');
      eq(changeSet.notes, '2020 VAT Rates');
    });

    it('should default last modified date to now', async () => {
      const before = new Date();

      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', 'Countries')`
        );
      });

      const changeSet = await rdf.getChangeSet(1);
      ok(changeSet.lastModified >= before);
    });

    it('should default entity tag to random hex', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', 'Countries')`
        );
      });

      const changeSet = await rdf.getChangeSet(1);
      match(changeSet.entityTag, /^[a-f|0-9]{20}$/);
    });
  });

  describe('Aggregates', () => {
    it('should aggregate data frames up to the specified change set', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_entity (id, name, version) VALUES
          (1, 'VAT Rate', 1)
        `);
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', '2020 VAT Rates'),
          (2, '2021-04-05T00:00:00.000Z', '2021 VAT Rates'),
          (3, '2022-04-05T00:00:00.000Z', '2022 VAT Rates')`
        );
        await tx.query(`INSERT INTO rdf_data_frame (id, change_set_id, entity_id, action) VALUES
          (1, 1, 1, 'POST'),
          (2, 1, 1, 'POST'),
          (3, 1, 1, 'POST'),
          (4, 2, 1, 'POST'),
          (5, 2, 1, 'POST'),
          (6, 2, 1, 'POST'),
          (7, 3, 1, 'POST'),
          (8, 3, 1, 'POST'),
          (9, 3, 1, 'POST')`
        );
        await tx.query(`INSERT INTO vat_rate_v1 (rdf_frame_id, type, rate) VALUES
          (1, 'standard', 0.10),
          (2, 'reduced', 0.05),
          (3, 'zero', 0),
          (4, 'standard', 0.125),
          (5, 'reduced', 0.7),
          (6, 'zero', 0),
          (7, 'standard', 0.15),
          (8, 'reduced', 0.10),
          (9, 'zero', 0)`
        );

        const { rows: aggregate1 } = await tx.query('SELECT * FROM get_vat_rate_v1_aggregate($1)', [1]);
        eq(aggregate1.length, 3);
        deq(aggregate1[0], { type: 'standard', rate: 0.10 });
        deq(aggregate1[1], { type: 'reduced', rate: 0.05 });
        deq(aggregate1[2], { type: 'zero', rate: 0 });

        const { rows: aggregate3 } = await tx.query('SELECT * FROM get_vat_rate_v1_aggregate($1)', [3]);
        eq(aggregate3.length, 3);
        deq(aggregate3[0], { type: 'standard', rate: 0.15 });
        deq(aggregate3[1], { type: 'reduced', rate: 0.10 });
      });
    });

    it('should exclude aggregates where the most recent frame was a delete', async () => {
      await rdf.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO rdf_entity (id, name, version) VALUES
          (1, 'VAT Rate', 1)
        `);
        await tx.query(`INSERT INTO rdf_change_set (id, effective_from, notes) VALUES
          (1, '2020-04-05T00:00:00.000Z', '2020 VAT Rates'),
          (2, '2021-04-05T00:00:00.000Z', '2021 VAT Rates'),
          (3, '2022-04-05T00:00:00.000Z', '2022 VAT Rates')`
        );
        await tx.query(`INSERT INTO rdf_data_frame (id, change_set_id, entity_id, action) VALUES
          (1, 1, 1, 'POST'),
          (2, 1, 1, 'POST'),
          (3, 1, 1, 'POST'),
          (4, 2, 1, 'POST'),
          (5, 2, 1, 'POST'),
          (6, 2, 1, 'POST'),
          (7, 3, 1, 'POST'),
          (8, 3, 1, 'POST'),
          (9, 3, 1, 'DELETE')`
        );
        await tx.query(`INSERT INTO vat_rate_v1 (rdf_frame_id, type, rate) VALUES
          (1, 'standard', 0.10),
          (2, 'reduced', 0.05),
          (3, 'zero', 0),
          (4, 'standard', 0.125),
          (5, 'reduced', 0.7),
          (6, 'zero', 0),
          (7, 'standard', 0.15),
          (8, 'reduced', 0.10)`
        );
        await tx.query(`INSERT INTO vat_rate_v1 (rdf_frame_id, type) VALUES
          (9, 'zero')`
        );

        const { rows: aggregate1 } = await tx.query('SELECT * FROM get_vat_rate_v1_aggregate($1)', [1]);
        eq(aggregate1.length, 3);
        deq(aggregate1[0], { type: 'standard', rate: 0.10 });
        deq(aggregate1[1], { type: 'reduced', rate: 0.05 });
        deq(aggregate1[2], { type: 'zero', rate: 0 });

        const { rows: aggregate3 } = await tx.query('SELECT * FROM get_vat_rate_v1_aggregate($1)', [3]);
        eq(aggregate3.length, 2);
        deq(aggregate3[0], { type: 'standard', rate: 0.15 });
        deq(aggregate3[1], { type: 'reduced', rate: 0.10 });
      }, { exclusive: true });
    });
  })
});

class TestReferenceDataFramework extends ReferenceDataFramework {
  async wipe() {
    return this.withTransaction(async (tx) => {
      await tx.query('DELETE FROM vat_rate_v1');
      await tx.query('DELETE FROM rdf_notification');
      await tx.query('DELETE FROM rdf_hook');
      await tx.query('DELETE FROM rdf_data_frame');
      await tx.query('DELETE FROM rdf_projection_entity');
      await tx.query('DELETE FROM rdf_entity');
      await tx.query('DELETE FROM rdf_change_set');
      await tx.query('DELETE FROM rdf_projection');
    })
  }
}