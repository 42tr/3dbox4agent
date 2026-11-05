import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sdk/python'))
from auction_compare import summarize, execution_order

def run(status,tick,elapsed,sent,delivered,failed):
    return {'status':status,'elapsedSeconds':elapsed,'metrics':{'ticks':tick,'peerMessages':{'submitted':sent,'delivered':delivered,'failed':failed}}}

class AuctionCompareTest(unittest.TestCase):
    def test_excludes_incomplete_pairs_from_completion_differences(self):
        pairs=[{'planner':run('completed',10,1,0,0,0),'auction':run('completed',15,2,4,3,1)},
               {'planner':run('completed',8,1,0,0,0),'auction':run('timeout',99,10,6,4,2)}]
        groups,paired=summarize(pairs)
        self.assertEqual(groups[1]['completed'],1);self.assertEqual(groups[1]['timedOut'],1)
        self.assertEqual(groups[1]['completionTicks']['mean'],15);self.assertEqual(groups[1]['messagesSubmitted']['mean'],5)
        self.assertEqual(paired['bothCompleted'],1);self.assertEqual(paired['tickDifference']['mean'],5);self.assertEqual(paired['elapsedDifference']['mean'],1)
    def test_execution_order_is_balanced_and_deterministic(self):
        self.assertEqual([execution_order('alternating', i) for i in range(4)], [['planner','auction'],['auction','planner'],['planner','auction'],['auction','planner']])
        self.assertEqual(execution_order('planner-first', 3), ['planner','auction'])
        self.assertEqual(execution_order('auction-first', 0), ['auction','planner'])
        with self.assertRaises(ValueError): execution_order('alternating', -1)
    def test_no_completed_pairs(self):
        groups,paired=summarize([{'planner':run('failed',2,1,0,0,0),'auction':run('timeout',5,2,3,1,2)}])
        self.assertIsNone(groups[0]['completionTicks']['mean']);self.assertIsNone(paired['tickDifference']['mean']);self.assertEqual(paired['bothCompleted'],0)
if __name__=='__main__':unittest.main()
