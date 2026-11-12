import { Module } from '@nestjs/common';
import { RetrievalModule } from '../search/retrieval.module';
import { QA_MODEL } from './application/qa-model.port';
import { QaService } from './application/qa.service';
import { QaController } from './http/qa.controller';
import { HttpQaModel } from './infra/http-qa-model';

/** Q&A with citations (T5.4): routing, cited lookup answers over retrieval, and the number tool. */
@Module({
  imports: [RetrievalModule],
  controllers: [QaController],
  providers: [{ provide: QA_MODEL, useClass: HttpQaModel }, QaService],
})
export class QaModule {}
